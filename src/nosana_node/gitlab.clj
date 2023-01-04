(ns nosana-node.gitlab
  (:require [nos.core :as flow]
            [clojure.edn :as edn]
            [nosana-node.nosana :refer [finish-flow]]
            [nosana-node.pipeline :as pipeline]
            [nosana-node.secrets :as secrets]
            [clojure.core.async :as async :refer
             [<!! <! >!! go go-loop >! timeout take! chan put!]]
            [taoensso.timbre :as logg :refer [log]]
            [nosana-node.pipeline :as pipeline]
            [konserve.core :as kv]
            [clojure.string :as string]
            [cheshire.core :as json]
            [nosana-node.util
             :refer [ipfs-hash->bytes bytes->ipfs-hash]
             :as util]))

(defmethod finish-flow "Gitlab"
  [flow {:keys [secrets-endpoint] :as conf}]
  (let [job-addr (get-in flow [:state :input/job-addr])
        results  (pipeline/make-flow-results conf flow)
        secret   (str job-addr "/result")]
    (log :info "Storing job results in secret")
    (secrets/set-secrets conf {secret results})
    (let [job-result {:finished-at (flow/current-time)
                      :state       {:nosana/secrets [secret]}
                      :results     [:nos/secret secrets-endpoint secret]}]
      (pipeline/ipfs-upload job-result conf))))
