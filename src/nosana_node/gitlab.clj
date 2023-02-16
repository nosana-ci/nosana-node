(ns nosana-node.gitlab
  (:require [nos.core :as flow]
            [clojure.edn :as edn]
            [nosana-node.nosana :refer [finish-flow create-flow ipfs-upload]]
            [nosana-node.pipeline :as pipeline]
            [nosana-node.secrets :as secrets]
            [clojure.core.async :as async :refer
             [<!! <! >!! go go-loop >! timeout take! chan put!]]
            [taoensso.timbre :as logg :refer [log]]
            [konserve.core :as kv]
            [clojure.string :as string]
            [cheshire.core :as json]
            [nosana-node.util
             :refer [ipfs-hash->bytes bytes->ipfs-hash]
             :as util]))

(defmethod create-flow "github-flow"
  [job run-addr run conf]
  (let [job-addr (:job run)]
    (-> job
        (assoc-in [:state :input/job-addr] (.toString job-addr))
        (assoc-in [:state :input/run-addr] (.toString run-addr))
        flow/build
        (assoc :default-args (:nos-default-args conf)))))

(defmethod create-flow "Gitlab"
  [job run-addr run conf]
  (let [job-addr (:job run)]
    (-> job
        (assoc-in [:state :input/job-addr] (.toString job-addr))
        (assoc-in [:state :input/run-addr] (.toString run-addr))
        flow/build
        (assoc :default-args (:nos-default-args conf)))))

(defmethod finish-flow "Gitlab"
  [flow {:keys [secrets-endpoint] :as conf}]
  (let [job-addr (get-in flow [:state :input/job-addr])
        results  (:state flow)
        secret   (str job-addr "/result")]
    (log :info "Storing job results in secret")
    (secrets/set-secrets conf {secret results})
    (let [job-result {:finished-at (flow/current-time)
                      :state       {:nosana/secrets [secret]}
                      :results     [:nos/secret secrets-endpoint secret]}]
      (ipfs-upload job-result conf))))
