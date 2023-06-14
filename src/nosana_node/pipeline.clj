(ns nosana-node.pipeline
  (:require [clojure.edn :as edn]
            [taoensso.timbre :refer [log]]
            [clj-http.client :as http]
            [clojure.java.shell :as sh]
            [cheshire.core :as json]
            [clojure.core.async :refer [chan >!! <!! put!]]
            [konserve.memory :refer [new-mem-store]]
            [nosana-node.nosana :refer [finish-flow create-flow ipfs-upload]]
            [clojure.java.io :as io]
            [nos.core :as nos]
            [nos.ops.docker :as docker]
            [clj-yaml.core :as yaml]
            [clojure.string :as string]))

(def pinata-api-url "https://api.pinata.cloud")

(def example-job
  {:type     "Github"
   :url      "https://github.com/unraveled/dummy"
   :commit   "ce02322afff927af93ba298a9300800e64ae2d9d"
   :pipeline "nosana:\n  description: Run Test \n\nglobal:\n  image: registry.hub.docker.com/library/node:16\n  trigger:\n    branch:\n      - all\n\njobs:\n  - name: install-deps and run test\n    commands: \n      - npm ci\n      - npm run test\n"})

(def base-flow
  "The default flow for a pipeline which includes cloning of the
  repository."
  {:ops
   [{:op   :container/run
     :id   :checkout
     :args {:cmds      [{:cmd [:nos/str
                               "sh -c 'echo \u001b[32m$ git clone "
                               [:nos/ref :input/repo] " project\033[0m" " && "
                               "git clone " [:nos/ref :input/repo] " project" " && "
                               "echo \u001b[32m$ cd /root/project\033[0m && cd /root/project"
                               " && "
                               "echo \u001b[32m$ git checkout "
                               [:nos/ref :input/commit-sha] "\033[0m" " && "
                               "git checkout " [:nos/ref :input/commit-sha] "'"]}]
            :workdir   "/root"
            :artifacts [{:path "project" :name "checkout"}]
            :conn      {:uri [:nos/vault :podman-conn-uri]}
            :image     "registry.hub.docker.com/bitnami/git:latest"}}]})

(defn prep-env
  "Process job env entries."
  [env]
  (->> env
       (map (fn [[k v]]
              (case (:type v)
                "nosana/secret" [(name k) [:nosana/secret (:endpoint v) (:value v)]]
                "nos/vault"     [(name k) [:nos/vault (:value v)]]
                "string"        [(name k) v]
                [k v])))
       (into {"TERM"        "xterm-color"
              "FORCE_COLOR" "1"
              "CLICOLOR"    "1"} )))

(defn trigger->env
  "Convert a pipeline trigger object to environment variable map."
  [{:keys [commit repo job run]}]
  {"NOS_COMMIT_SHA"  commit
   "NOS_REPOSITORY"  repo
   "NOS_JOB_ADDRESS" job
   "NOS_RUN_ADDRESS" run})

(defn escape [cmd]
  (string/replace cmd "'" "'\"'\"'"))

(defn echo-and-run [cmds]
  (->> cmds
       (map (fn [cmd] [(str "echo '" (str "\u001b[32m$ " (escape cmd)) "'\033[0m")
                       cmd]))
       flatten))

(defn make-job-cmds
  "Embed a seq of shell commands into a single `sh -c` statement."
  [cmds]
  (let [cmds-escaped
        (->> cmds
             (map (fn [cmd] [(str "echo \u001b[32m" "$ '" cmd "'\033[0m") cmd]))
             flatten
             (map #(string/replace % "'" "'\\''")))]
    (str "sh -c '" (string/join " && " cmds-escaped) "'")))

(defn make-job-cmds-shell-file [cmds]
  (let [full-cmd
        (->> cmds
             echo-and-run
             (concat ["#!/bin/sh"
                      "if set -o | grep pipefail > /dev/null; then set -o pipefail; fi",
                      "set -o errexit"
                      "set +o noclobber"])
             (string/join "\n"))]
    (str "sh -c '"
         (escape (str "echo '" (escape full-cmd) "' | sh"))
         "'")))

(defn make-job
  "Create flow segment for a `job` entry of the pipeline.
  Input is a keywordized map that is a parsed yaml job entry."
  [{:keys [name commands artifacts resources environment image work-dir image-pull-secret]
    :or   {resources []
           work-dir  "/root/project"}}
   {{global-image :image
     global-environment :environment
     global-image-pull-secret :image-pull-secret} :global
    :as pipeline}]
    {:op   :container/run
     :id   (keyword name)
     :args {:cmds      [{:cmd (make-job-cmds-shell-file commands)}]
            :image     (if (not (or image global-image))
                            "ubuntu:latest"
                            (or image global-image))
            :image-pull-secret (or  image-pull-secret  global-image-pull-secret)
            :env       (prep-env (merge global-environment environment))
            :conn      {:uri [:nos/vault :podman-conn-uri]}
            :workdir   work-dir
            :resources (cons {:name "checkout" :path "/root"}
                             (map (fn [r] {:name      (:name r)
                                           :required (if (:required r) true false)
                                           :path
                                           (if (not (:path r))
                                             "."
                                             (:path r))})
                                  resources))
          :artifacts (map (fn [a] {:paths    (if (not (or (:path a) (:paths a)))
                                               [(:name a)]
                                               (or (:paths a) [(:path a)]))
                                   :name     (:name a)
                                   :required (:required a)})
                          artifacts)}
     :deps [:checkout]})

(defn pipeline->flow-ops
  [{:keys [nos global jobs] :as pipeline}]
  (let [work-dir "/root"
        {:keys [environment allow-failure image]} global]
    (map #(make-job % pipeline) jobs)))

(defn load-yml
  "Load a pipeline from a YAML file.
  Useful for local testing. Expects an extra `trigger` section in the
  yaml with `trigger:` and `commit-sha:` keys, to indicate which repo
  must be cloned."
  [path]
  (let [{:keys [trigger global jobs] :as pipeline}
        (-> path slurp yaml/parse-string)]
    (cond->
        (-> base-flow
            (update :ops concat (pipeline->flow-ops pipeline))
            (assoc-in [:state :input/repo] (:repo trigger))
            (assoc-in [:state :input/commit-sha] (:commit-sha trigger)))
      (:allow-failure? global) (assoc :allow-failure? (:allow-failure? global)))))

(defmethod create-flow "Pipeline"
  [job run-addr run conf]
  (let [pipeline (-> (:pipeline job)
                     yaml/parse-string
                     (update-in [:global :environment]
                                merge (trigger->env job)))]
    (-> base-flow
        (update :ops #(into [] (concat % (pipeline->flow-ops pipeline))))
        (assoc-in [:state :input/repo] (:url job))
        (assoc-in [:state :input/commit-sha] (:commit job))
        (assoc-in [:state :input/job-addr] (.toString (:job run)))
        (assoc-in [:state :input/run-addr] (.toString run-addr))
        nos/build
        (assoc :default-args (:nos-default-args conf)))))

(defn has-local-git-changes? [dir untracked-files?]
  (-> (sh/sh "git"
             "-C" dir
             "status"
             "--porcelain")
      :out
      string/blank?
      not))

(defn make-local-git-artifact! [dir artifact-name flow-id commit]
  (println "Creating artifact " )
  (let [artifact     (str dir "/.nos/artifacts/" artifact-name)
        _            (io/make-parents artifact)
        needs-stash? (and (not commit) (has-local-git-changes? dir false))
        stash        (cond
                       needs-stash? (-> (sh/sh "git" "-C" dir "stash" "create")
                                        :out
                                        (string/replace "\n" ""))
                       (not commit) "HEAD"
                       :else        commit)

        _ (when needs-stash?
            (println "Created stash " stash " for working directory"))

        {:keys [err out exit]} (sh/sh "git"
                                      "-C" dir
                                      "archive"
                                      "--prefix" "project/"
                                      "--format" "tar"
                                      "--output" artifact
                                      stash)]
    (cond (pos? exit) (throw (ex-info "Failed to make artifact" {:err err}))
          :else
          true)))

(defn get-git-sha [dir]
  (-> (sh/sh "git" "-C" dir "rev-parse" "HEAD")
      :out
      (string/replace "\n" "")))

(defn add-global-secrets
  "Add secrets from `vault` to `global.environment` of the yaml."
  [pipeline vault]
  (let [global-env (get-in pipeline [:global :environment] {})
        new-env    (reduce-kv (fn [m k v]
                                (assoc m k {:type "nos/vault" :value k}))
                              global-env vault)]
    (assoc-in pipeline [:global :environment] new-env)))

(defn run-local-pipeline [dir vault]
  (let [yaml-path  (str dir "/.nosana-ci.yml")
        vault-path (str dir "/.nosana-secrets.json")

        _ (when (not (.exists (io/as-file yaml-path)))
            (throw (Exception.
                    "Missing a .nosana-ci.yml file in the current directory")))

        yaml            (slurp yaml-path)
        local-vault     (if (.exists (io/as-file vault-path))
                          (-> vault-path slurp json/decode)
                          {})
        commit          (get-git-sha dir)
        pipeline        (-> yaml yaml/parse-string
                            (add-global-secrets local-vault))
        pipeline-commit (:git-branch vault)

        flow
        (-> {:ops []}
            (update :ops #(into [] (concat % (pipeline->flow-ops pipeline))))
            (assoc-in [:state :input/commit-sha] commit)
            nos/build
            (assoc :default-args
                   {:container/run
                    {:conn          {:uri [:nos/vault :podman-conn-uri]}
                     :inline-logs?  true
                     :artifact-path (str dir "/.nos/artifacts")
                     :stdout?       true}}))]
    (make-local-git-artifact! dir "checkout" (:id flow) pipeline-commit)
    (let [flow-engine {:store     (<!! (new-mem-store))
                       :chan      (chan)
                       :nos/vault (merge vault local-vault)}
          results     (nos/run-flow! flow-engine flow)]
      (docker/gc-volumes! results {:uri (:podman-conn-uri vault)})
      (shutdown-agents))))

(defmethod finish-flow "Pipeline" [flow conf]
  (let [results    (:state flow)
        job-result {:nos-id      (:id flow)
                    :finished-at (nos/current-time)
                    :results     results}
        ipfs       (ipfs-upload job-result conf)]
    (log :info "Job results uploaded to " ipfs)
    ipfs))
