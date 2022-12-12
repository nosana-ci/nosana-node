(ns nosana-node.pipeline
  (:require [clojure.edn :as edn]
            [taoensso.timbre :refer [log]]
            [clj-http.client :as http]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clj-yaml.core :as yaml]
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
   [{:op   :docker/run
     :id   :checkout
     :args [{:cmds      [{:cmd [::nos/str "git clone " [::nos/ref :input/repo] " project"]}
                         {:cmd      [::nos/str "git checkout " [::nos/ref :input/commit-sha]]
                          :work-dir "/root/project"}]
             :artifacts [{:source "project" :dest "checkout"}]
             :conn      {:uri [::nos/vault :podman-conn-uri]}
             :image     "registry.hub.docker.com/bitnami/git:latest"}]}]})

(defn prep-env
  "Process job env entries."
  [env]
  (->> env
       (map (fn [[k v]]
              (case (:type v)
                "nosana/secret" [k [:nosana-node.core/secret (:endpoint v) (:value v)]]
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
  {:op   :docker/run
   :id   (keyword name)
   :args [{:cmds      (map (fn [c] {:cmd c}) commands)
           :image     (or image global-image)
           :env       (prep-env (merge global-environment environment))
           :conn      {:uri [::nos/vault :podman-conn-uri]}
           :work-dir  work-dir
           :resources (cons {:source "checkout" :dest "/root"}
                            (map (fn [r] {:source r :dest "/root/project"}) resources))
           :artifacts (map (fn [a] {:source (:path a) :dest (:name a)}) artifacts)}]
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
            (assoc-in [:results :input/repo] (:repo trigger))
            (assoc-in [:results :input/commit-sha] (:commit-sha trigger)))
      (:allow-failure? global) (assoc :allow-failure? (:allow-failure? global)))))

(defn ipfs-upload
  "Converts a map to a JSON string and pins it using Pinata.
  Returns the CID string of the IPFS object."
  [obj {:keys [pinata-jwt]}]
  (log :trace "Uploading object to ipfs")
  (->
   (http/post (str pinata-api-url "/pinning/pinJSONToIPFS")
              {:headers {:Authorization (str "Bearer " pinata-jwt)}
               :content-type :json
               :body (json/encode obj)})
   :body
   json/decode
   (get "IpfsHash")))

;; this coerces the flow results for Nosana and uploads them to IPFS. then
;; finalizes the Solana transactions for the job
(defn upload-flow-results
  [{:nos/keys [vault]} flow]
  (let [end-time   (nos/current-time)
        ;; put the results of some operators in map to upload to IPFS. also
        ;; we'll slurp the content of the docker logs as they're only on the
        ;; local file system.
        res        (->> flow
                        :results
                        (reduce-kv
                         (fn [m k [status results & more]]
                           ;; qualified keywords are most likely
                           ;; nostromo intrinsics we can ignore
                           (if (not (qualified-keyword? k))
                             (let [[status results]
                                   (if (= status :nos.core/error)
                                     [:pipeline-failed (first more)]
                                       [status results])]
                               (assoc m k
                                      [status
                                       (map #(if (:log %)
                                               (update %
                                                       :log
                                                       (fn [l] (-> l slurp json/decode))) %)
                                            results)]))
                             m))
                         {}))
        job-result {:nos-id      (:id flow)
                    :finished-at (nos/current-time)
                    :results     res}

        ipfs       (ipfs-upload job-result vault)]
    (log :info "Job results uploaded to " ipfs)
    (assoc-in flow [:results :result/ipfs] ipfs)))

(defn make-from-job
  [job job-addr run-addr]
  (let [pipeline (-> (:pipeline job)
                     (update-in [:global :environment] merge (trigger->env job)))]
    (-> base-flow
        (update :ops #(into [] (concat % (pipeline->flow-ops pipeline))))
        (assoc-in [:results :input/repo] (:url job))
        (assoc-in [:results :input/commit-sha] (:commit job))
        (assoc-in [:results :input/job-addr] (.toString job-addr))
        (assoc-in [:results :input/run-addr] (.toString run-addr))
        nos/build)))
