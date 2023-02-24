(ns nosana-node.system
  (:require [nosana-node.nosana :as nosana]
            [clojure.core.async :as async :refer
             [<!! <! >!! go go-loop >! timeout take! chan put!]]
            [ring.adapter.jetty :as jetty]
            [konserve.core :as kv]
            [clojure.string :as string]
            [taoensso.timbre :as log]
            [nosana-node.cors :refer [wrap-all-cors]]
            [ring.util.codec :refer [form-decode]]))

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

(defn get-op-log [store uri]
  (let [[[_ flow-id op-id-raw]]
        (re-seq #"/nosana/logs/([a-zA-Z0-9\-_]+)/([a-zA-Z0-9\-%\s\+]+)" uri)

        op-id          (form-decode op-id-raw)
        flow-id-mapped (<!! (kv/get store [:job->flow flow-id]))
        flow-id        (if flow-id-mapped flow-id-mapped flow-id)

        log (try (slurp (str "/tmp/nos-logs/" flow-id "/" op-id ".txt"))
                 (catch Exception e nil))]
    (if (and flow-id op-id log)
      {:status  200
       :headers {"Content-Type" "text/plain; charset=UTF-8"}
       :body    log}
      {:status  404
       :headers {"Content-Type" "text/plain"}
       :body    "Not found"})))

(defn handler [{:keys [uri nos/store] :as request}]
  (cond
    (or (= uri "/health")
        (= uri "/"))
    {:status  200
     :headers {"Content-Type" "text/html"}
     :body    "OK"}
    (string/starts-with? uri "/nosana/logs/")
    (get-op-log store uri)
    :else             {:status  200
                       :headers {"Content-Type" "text/html"}
                       :body    "Not found"}))

(defn use-wrap-ctx [{:keys [http/handler] :as ctx}]
  (assoc ctx :http/handler (fn [req]
                             (handler (merge (dissoc ctx :nos/vault) req)))))


(defn use-jetty [{:keys [http/handler] :as system}]
  (let [server (jetty/run-jetty (wrap-all-cors handler)
                {:host  "0.0.0.0"
                 :port  3000
                 :join? false})]
    (update system :system/stop conj #(.stop server))))
