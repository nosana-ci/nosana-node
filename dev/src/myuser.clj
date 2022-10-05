(ns myuser
  (:require [nos.core :as flow]
            [taoensso.timbre :refer [log]]
            [nosana-node.main :as main]
            [nosana-node.nosana :as nos]
            [clojure.core.async :as async :refer [<!! <! >!!]]
            [konserve.core :as kv]))



(def sys @main/global-system)
(def fe {:vault (:nos/vault sys) :chan (:nos/flow-chan sys) :store (:nos/store sys) :log-dir "/tmp/logs/"})

(defn kv-get [key]
  (<!! (kv/get-in (:store fe) key)))

(defn run-flow [flow]
  (prn ">> Starting flow from REPL >>" (:id flow))
  (->>
   (flow/run-flow! fe flow)
   (kv/assoc-in (:store fe) [(:id flow)])
   <!!
   second))

(defn get-signer-address
  "Get signer Solana public key as string"
  []
  (-> sys :nos/vault nos/get-signer-key .getPublicKey .toString))



(defn finish-stuck-job! [job-addr network]
  (let [job (nos/get-job job-addr network)]
    ;; if we are not the node that claimed, try to reclaim
    (when (not (= (get-signer-address)  (:node job)))
      (log :info "Reclaiming job " job-addr)
      (let [claim-sig
            (nos/reclaim-job-tx! job-addr (-> sys :nos/vault nos/get-signer-key) network)]
        (log :info "Reclaimed job, waiting on Solana" claim-sig)
        (<!! (nos/get-solana-tx claim-sig network))
        (log :info "Reclaim tx found")))

    (let [flow (nos/make-job-flow (:job-ipfs job) job-addr)
          flow-flow (run-flow flow)
          max-tries 100]
      (loop [tries 0]
        (Thread/sleep 5000)
        (if (< tries max-tries)
          (let [cur-flow (kv-get [(:id flow)])]
            (prn "try tries")
            (if (nos/flow-finished? cur-flow)
              (let [finish-tx (nos/finish-job-tx!
                               job-addr
                               (get-in cur-flow [:results :result/ipfs])
                               (nos/get-signer-key (:vault fe))
                               network)]
                (prn "FINISHED JOB " finish-tx))
              (recur (inc tries))))
          (prn ">> Not finished after timeout!!!")))
      flow-flow)))
