(ns nosana-node.system
  (:require [nosana-node.nosana :as nosana]
            [nosana-node.solana :as sol]
            [taoensso.timbre :refer [log]]
            [nosana-node.nosana :as nos]
            [clojure.core.async :as async :refer
             [<!! <! >!! go go-loop >! timeout take! chan put!]]
            [cheshire.core :as json]
            [ring.adapter.jetty :as jetty]
            [konserve.core :as kv]
            [nos.core :as flow]
            [clojure.string :as string]
            [taoensso.timbre :as log]
            [nosana-node.cors :refer [wrap-all-cors]]
            [ring.util.codec :refer [form-decode]])
  (:import [org.p2p.solanaj.utils TweetNaclFast TweetNaclFast$Signature]))

(defn stop-system [{:keys [system/stop]}]
  (doseq [f stop]
    (log/info "stopping:" (str f))
    (f)))

(defn use-when [f & components]
  (fn [sys]
    (if (f sys)
      (update sys :system/components #(concat components %))
      sys)))

(defn start-system [system-atom init]
  (stop-system @system-atom)
  (reset! system-atom (merge {:system/stop '()} init))
  (loop [{[f & components] :system/components :as sys} init]
    (when (some? f)
      (log/trace "starting:" (str f))
      (recur (reset! system-atom (f (assoc sys :system/components components))))))
  @system-atom)

(def verify-sig-for-job
  (memoize
   (fn [project-addr job-addr sig]
     (sol/verify-signature project-addr
                           (.getBytes (str "nosana_job_" job-addr) "UTF-8")
                           sig))))

(defn authorized-for-flow?
  "Returns `true` if signature is allowed to access the flow results.
  At the moment only Gitlab jobs are restricted."
  [sig flow solana-network nos-programs]
  (let [job-type (get-in flow [:state :nosana/job-type])
        job-addr (get-in flow [:state :input/job-addr])]
    (cond
      (= job-type "Gitlab")
      (let [{:keys [project]} (nos/get-job {:network solana-network
                                            :programs nos-programs}
                                           job-addr)]
        (log :info "Verifying signature project = "  project ", job-addr = " job-addr ", sig = " sig)
        (let [verified? (verify-sig-for-job project job-addr sig)]
          (when (not verified?)
            (log :info "Invalid signature provided"))
          verified?))
      :default
      true)))

(def resp-404
  {:status 404
   :headers {"Content-Type" "text/plain"}
   :body "Not found"})

(defn get-op-log
  "Handler for getting the logs of an op in a flow.
  The flow ID and op ID are encoded in the `uri`."
  [store uri http-headers solana-network nos-programs]
  (let [auth-header (get http-headers "authorization")

        [[_ flow-id op-id-raw] :as boo]
        (re-seq #"/nosana/logs/([a-zA-Z0-9\-_]+)(?:/([a-zA-Z0-9\-%\s\+]+))?" uri)

        op-id (when op-id-raw (form-decode op-id-raw))
        flow-id-mapped (<!! (kv/get store [:job->flow flow-id]))

        flow-id (if flow-id-mapped flow-id-mapped flow-id)

        flow (<!! (kv/get store flow-id))]
    (cond
      (or (not flow)
          (not (authorized-for-flow? auth-header flow solana-network nos-programs)))
      resp-404

      (not op-id)
      {:status 200
       :body (json/encode {:nos-id (:id flow)
                           :finished-at nil
                           :results (:state flow)})}

      :default
      (let [log (try (slurp (str "/tmp/nos-logs/" flow-id "/" op-id ".txt"))
                     (catch Exception e nil))]
        (if (and flow-id op-id log)
          {:status  (if (contains? (:state flow) op-id) 200 206)
           :headers {"Content-Type" "text/plain; charset=UTF-8"}
           :body    log}
          resp-404)))))

(defn handler [{:keys [uri nos/store headers nos/solana-network
                       nos/programs nos/work-loop-chan] :as request}]
  (cond
    (or (= uri "/health")
        (= uri "/"))
    {:status  200
     :headers {"Content-Type" "text/html"}
     :body    "OK"}
    (string/starts-with? uri "/nosana/logs/")
    (get-op-log store uri headers solana-network programs)
    (string/starts-with? uri "/nosana/trigger-job")
    (do
      (>!! work-loop-chan :poll)
      {:status 200 :body "OK"})
    :else             {:status  200
                       :headers {"Content-Type" "text/html"}
                       :body    "Not found"}))

(defn use-wrap-ctx
  "Middleware that injects the system map into the request after
  removing `:nos:vault`"
  [{:keys [http/handler] :as ctx}]
  (assoc ctx :http/handler (fn [req]
                             (handler (merge (dissoc ctx :nos/vault) req)))))


(defn use-jetty
  "Component that starts a HTTP server with `handler`."
  [{:keys [http/handler] :as system}]
  (let [port (get-in system [:nos/vault :port])
        server (jetty/run-jetty (wrap-all-cors handler)
                                {:host "0.0.0.0"
                                 :port port
                                 :join? false})]
    (log/log :info "Started HTTP server on port " port)
    (update system :system/stop conj #(.stop server))))
