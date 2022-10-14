(ns user
  (:require
   [taoensso.timbre :refer [log]]
   [clojure.java.io :as io]
   nosana-node.handler
   [clojure.pprint :refer [pprint]]
   [taoensso.timbre :as timbre]
   [duct.core :as duct]
   [integrant.repl :refer [halt reset resume set-prep! prep init]]
   [integrant.repl.state :refer [config system]]
   [nos.core :as flow]
   nos.module.http
   [nosana-node.util :refer [bytes->hex hex->bytes base58] :as util]
   nos.ops.git
   [nos.ops.docker :as docker]
   nos.system
   [aero.core :refer (read-config)]
   [konserve.core :as kv]
   [integrant.core :as ig]
   [clojure.core.async :as async :refer [<!! <! >!!]]
   [nos.store :as store]
   [nosana-node.nosana :as nos]
   [nosana-node.solana :as sol])
  (:import [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
            Account Message AccountMeta]))

(duct/load-hierarchy)

(def conf nil)

(defn go []
  (integrant.repl/go)
  (alter-var-root #'conf (fn [_] (nos/make-config system)))
  :ready)

(defn get-config []
  (duct/read-config (io/resource "system.edn")))

(defn kv-get [key]
  (<!! (kv/get-in (:nos/store system) key)))

(defn kv-set [key val]
  (<!! (kv/assoc (:nos/store system) key val)))

(defn run-flow [flow]
  (prn ">> Starting flow from REPL >>" (:id flow))
  (->>
   (flow/run-flow! (:nos/flow-engine system) flow)
   (kv/assoc-in (:nos/store system) [(:id flow)])
   <!!
   second))

(defn expand-flow [flow-id graph]
  (let [flow (->> flow-id (conj []) kv-get)]
    (flow/add-ops flow graph)))

(defn fe [] (:nos/flow-engine system))

(defn memory-usage []
  (prn (.freeMemory (Runtime/getRuntime))))

(set-prep! #(duct/prep-config (get-config) [:duct.profile/dev]))

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
  (clojure.core.async/go (nos/work-loop conf system))
  true)

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
