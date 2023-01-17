(ns nosana-node.pipeline
  (:require [clojure.edn :as edn]
            [taoensso.timbre :refer [log]]
            [clj-http.client :as http]
            [cheshire.core :as json]
            [nosana-node.nosana :refer [finish-flow create-flow ipfs-upload]]
            [clojure.java.io :as io]
            [nos.core :as nos]
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
     :args {:cmds      [{:cmd [:nos/str "git clone " [:nos/ref :input/repo] " project"]}
                        {:cmd      [:nos/str "git checkout " [:nos/ref :input/commit-sha]]
                         :workdir "/root/project"}]
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
                "nosana/secret" [k [:nosana/secret (:endpoint v) (:value v)]]
                "string" [k v]
                [k v])))
       (into {})))

(defn trigger->env
  "Convert a pipeline trigger object to environment variable map."
  [{:keys [commit repo job run]}]
  {"NOS_COMMIT_SHA"  commit
   "NOS_REPOSITORY"  repo
   "NOS_JOB_ADDRESS" job
   "NOS_RUN_ADDRESS" run})

(defn make-job
  "Create flow segment for a `job` entry of the pipeline.
  Input is a keywordized map that is a parsed yaml job entry."
  [{:keys [name commands artifacts resources environment image work-dir]
    :or   {resources []
           work-dir  "/root/project"}}
   {{global-image :image global-environment :environment} :global
    :as pipeline}]
  {:op   :container/run
   :id   (keyword name)
   :args {:cmds      (map (fn [c] {:cmd c}) commands)
          :image     (or image global-image)
          :env       (prep-env (merge global-environment environment))
          :conn      {:uri [:nos/vault :podman-conn-uri]}
          :workdir   work-dir
          :resources (cons {:name "checkout" :path "/root"}
                           (map (fn [r] {:name r :path "/root/project"}) resources))
          :artifacts (map (fn [a] {:source (:path a) :dest (:name a)}) artifacts)}
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

(defmethod finish-flow "Pipeline" [flow conf]
  (let [results    (:state flow)
        job-result {:nos-id      (:id flow)
                    :finished-at (nos/current-time)
                    :results     results}
        ipfs       (ipfs-upload job-result conf)]
    (log :info "Job results uploaded to " ipfs)
    ipfs))
