(ns user
  (:require
   [clojure.edn :as edn]
   [taoensso.timbre :refer [log]]
   [clojure.java.io :as io]
   [cheshire.core :as json]
   [nosana-node.secrets :as secrets]
   nosana-node.handler
   [clojure.pprint :refer [pprint]]
   [taoensso.timbre :as timbre]
   [cognitect.test-runner :refer [test]]
   [contajners.core :as c]
   [nos.core :as flow]
   nos.module.http
   [nos.vault :refer [use-vault]]
   [nosana-node.system :as nos-sys
    :refer [start-system
            use-jetty]]
   [nosana-node.util :refer [bytes->hex hex->bytes base58] :as util]
   nos.ops.git
   [nos.ops.docker :as docker]
   [aero.core :refer (read-config)]
   [konserve.core :as kv]
   [clojure.core.async :as async :refer [<!! <! >!!]]
   [nos.store :as store]
   [nos.system :refer [use-nostromo]]
   [clojure.java.io :as io]
   [nosana-node.main :as main]
   [nosana-node.pipeline :as pl]
   [nosana-node.nosana :as nos :refer [use-nosana]]
   [nosana-node.solana :as sol])
  (:import [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
            Account Message AccountMeta]))

(defonce system (atom nil))

(defonce conf nil)

(defn go []
  (start-system
   system
   {:http/handler      #'nos-sys/handler
    :system/components [use-vault
                        use-jetty
                        store/use-fs-store
                        use-nostromo
                        use-nosana
                        ]
    :system/profile    :dev
    :nos/log-dir       "/tmp/logs"
    :nos/store-path    "/tmp/store"
    :nos/vault-path    (io/resource "config.edn")})
  (alter-var-root #'conf (fn [_] (nos/make-config @system)))
  :ready)

(defn stop [] (nos-sys/stop-system @system))

(defn kv-get [key]
  (<!! (kv/get-in (:nos/store system) key)))

(defn kv-set [key val]
  (<!! (kv/assoc (:nos/store system) key val)))

(defn run-flow [flow]
  (prn ">> Starting flow from REPL >>" (:id flow))
  (->>
   (assoc flow :default-args (:nos-default-args conf))
   (flow/run-flow! @system)
   (kv/assoc-in (:nos/store @system) [(:id flow)])
   <!!
   second))

(defn expand-flow [flow-id graph]
  (let [flow (->> flow-id (conj []) kv-get)]
    (flow/add-ops flow graph)))

(defn fe [] (:nos/flow-engine system))

(defn memory-usage []
  (prn (.freeMemory (Runtime/getRuntime))))

(defn get-signer-address
  "Get signer Solana public key as string"
  []
  (-> system :nos/vault nos/get-signer-key .getPublicKey .toString))

(defn get-signer
  "Get the signer keypair"
  []
  (-> system :nos/vault nos/get-signer-key))

(defn start-work-loop!
  "Start the polling for jobs in a background thread."
  []
  (clojure.core.async/go (nos/work-loop conf @system))
  true)

(defn start-run!
  "Start running a new Nostromo flow and return its flow ID."
  [run-addr]
  (let [run      (nos/get-run conf run-addr)
        job      (nos/get-job conf  (:job run))
        job-info (nos/download-job-ipfs (:ipfsJob job) conf)
        flow     (nos/create-flow job-info run-addr run conf)
        flow-id  (:id flow)]
    (log :info "Starting job" (-> run :job .toString))
    (log :trace "Processing flow" flow-id)
    (run-flow flow)))

;;(start-run! "AEBJMrNLvPE41GSvJvoMh2Zequt3CjWUpmLMgDphwwxU" )
(defn start-first-run!
  "Find our first run and run in the REPL."
  []
  (let [runs (nos/find-my-runs conf)]
    (prn "Found runs" runs)
    (when-let [[run-addr run] (first runs)]
      (let [job      (nos/get-job conf (:job run))
            job-info (nos/download-ipfs (util/bytes->ipfs-hash (:ipfsJob job)) conf)
            flow     (nos/create-flow job-info run-addr run conf)
            flow-id  (:id flow)]
        (run-flow flow)))))

(defn get-job-result-secret
  "Get the job results form the secret manager."
  [job]
  (get (secrets/get-secrets conf (secrets/login conf)) (str job "/result")))
;; (get-job-result-secret "7R67vVfRm5WsRUMzJo2NtyAkuFkB5aJ3ocFm6vAe8wQw")

;; (defn finish-stuck-job!
;;   "Finish a job that this node has claimed but never finished"
;;   [job-addr network]
;;   (let [job (nos/get-job job-addr network)]
;;     ;; if we are not the node that claimed, try to reclaim
;;     (when (or true (not (= (get-signer-address)  (:node job))))
;;       (log :info "Reclaiming job " job-addr)
;;       (let [claim-sig
;;             (nos/reclaim-job-tx! job-addr (-> system :nos/vault nos/get-signer-key) network)]
;;         (log :info "Reclaimed job, waiting on Solana" claim-sig)
;;         (<!! (nos/get-solana-tx< claim-sig network))
;;         (log :info "Reclaim tx found")))

;;     (let [flow      (nos/make-job-flow (:job-ipfs job) job-addr)
;;           flow-flow (run-flow flow)
;;           max-tries 100]
;;       (loop [tries 0]
;;         (Thread/sleep 5000)
;;         (if (< tries max-tries)
;;           (let [cur-flow (kv-get [(:id flow)])]
;;             (prn "try tries")
;;             (if (nos/flow-finished? cur-flow)
;;               (let [finish-tx (nos/finish-job-tx!
;;                                job-addr
;;                                (get-in cur-flow [:results :result/ipfs])
;;                                (-> system :nos/vault nos/get-signer-key)
;;                                network)]
;;                 (prn "FINISHED JOB " finish-tx))
;;               (recur (inc tries))))
;;           (prn ">> Not finished after timeout!!!")))
;;       flow-flow)))


(comment
  (run-flow
   (flow/build {:ops
                [{:op :docker/run
                  :id :bla
                  :args [{:image     "alpine"
                          :resources [{:source "/tmp/logs" :dest "/root"}]
                          :artifacts [{:source "/root" :dest "/tmp/myxy.tar"}]
                          :cmds      ["touch /root/test" "ls -l /root/tmp"]
                          :conn      {:uri "http://localhost:8080"}}]}]})))

;; to quit active run:
;; (->> (nos/find-my-runs conf) keys first PublicKey. (nos/quit-job conf))
