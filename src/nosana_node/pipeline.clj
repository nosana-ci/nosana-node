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
  {:ops
   [{:op   :docker/run
     :id   :checkout
     :args [{:cmds [{:cmd [::nos/str "git clone " [::nos/ref :input/repo] " project"]}
                    {:cmd      [::nos/str "git checkout " [::nos/ref :input/commit-sha]]
                     :work-dir "/root/project"}]
             :artifacts [{:source "project" :dest "checkout"}]
             :image "registry.hub.docker.com/bitnami/git:latest"}]}]})

(defn make-job
  "Create flow segment for a `job` entry of the pipeline."
  [{:keys [name commands artifacts resources environment image]
    :or   {resources []}}
   global-image
   global-environment]
  {:op   :docker/run
   :id   (keyword name)
   :args [{:cmds      (map (fn [c] {:cmd c}) commands)
           :image     (or image global-image)
           :env       (merge global-environment environment)
           :conn      {:uri [::nos/vault :podman-conn-uri]}
           :work-dir  "/root/project"
           :resources (cons {:source "checkout" :dest "/root"}
                            (map (fn [r] {:source r :dest "/root"}) resources))
           :artifacts (map (fn [a] {:source (:path a) :dest (:name a)}) artifacts)}]
   :deps [:checkout]})

(defn pipeline->flow-ops
  [{:keys [nos global jobs]}]
  (let [work-dir "/root"
        {:keys [environment allow-failure image]} global]
    (map #(make-job % image environment) jobs)))

(defn load-yml
  "Expects a trigger section in the yaml"
  [path]
  (let [{:keys [trigger global jobs] :as pipeline}
        (-> path slurp yaml/parse-string)]
    (-> base-flow
        (update :ops concat (pipeline->flow-ops pipeline))
        (assoc-in [:results :input/repo] (:repo trigger))
        (assoc-in [:results :input/commit-sha] (:commit-sha trigger)))))

(defn ipfs-upload
  "Converts a map to a JSON string and pins it using Pinata"
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
(defmethod nos/handle-fx :nos.nosana/complete-job
  [{:keys [vault] :as fe} op fx flow]
  (let [end-time   (nos/current-time)
        ;; put the results of some operators in map to upload to IPFS. also
        ;; we'll slurp the content of the docker logs as they're only on the
        ;; local file system.
        res        (->> flow
                        :results
                        (reduce-kv
                         (fn [m k [status results]]
                           (if (not (qualified-keyword? k))
                             (assoc m k
                                    (if (= status :error)
                                      [:error results]
                                      [status
                                       (map #(if (:log %)
                                               (update %
                                                       :log
                                                       (fn [l] (-> l slurp json/decode))) %)
                                            results)]))
                             m))
                         {}))
        _ (prn "hihi " res)
        job-result {:nos-id      (:id flow)
                    :finished-at (nos/current-time)
                    :results     res}
        _          (log :info "Uploading job result")
        ipfs       (ipfs-upload job-result vault)]
    (log :info "Job results uploaded to " ipfs)
    (assoc-in flow [:results :result/ipfs] ipfs)
    res))

(defn make-from-job
  [job job-addr run-addr]
  (let [flow   (-> base-flow
                   (update :ops #(into [] (concat % (pipeline->flow-ops (:pipeline job)))))
                   (assoc-in [:results :input/repo] (:url job))
                   (assoc-in [:results :input/commit-sha] (:commit job))
                   (assoc-in [:results :input/job-addr] (.toString job-addr))
                   (assoc-in [:results :input/run-addr] (.toString run-addr)))
        last-op-id (-> flow :ops last :id)
        wrap-up-op {:op :fx :id :wrap-up :args [[:nos.nosana/complete-job]] :deps [last-op-id]}]
    (->
     flow
     (update :ops conj wrap-up-op)
     nos/build)))
