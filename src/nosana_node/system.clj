(ns nosana-node.system
  (:require [nosana-node.nosana :as nosana]
            [ring.adapter.jetty :as jetty]
            [clojure.string :as string]
            [taoensso.timbre :as log]
            [clojure.tools.namespace.repl :as tn-repl]
            [nrepl.server :as nrepl-server]
            [cider.nrepl :refer (cider-nrepl-handler)]
            [ring.util.codec :refer [form-decode]]))

(defn stop-system [{:keys [system/stop]}]
  (doseq [f stop]
    (log/info "stopping:" (str f))
    (f)))

(defn refresh-system [{:keys [system/after-refresh] :as system}]
  (stop-system system)
  (tn-repl/refresh :after after-refresh))

(defn start-system [system-atom init]
  (stop-system @system-atom)
  (reset! system-atom (merge {:system/stop '()} init))
  (loop [{[f & components] :system/components :as sys} init]
    (when (some? f)
      (log/info "starting:" (str f))
      (recur (reset! system-atom (f (assoc sys :system/components components))))))
  (log/info "System started.")
  @system-atom)

(defn get-op-log [uri]
  (let [[[_ flow-id op-id-raw]]
        (re-seq #"/nosana/logs/([a-zA-Z0-9\-]+)/([a-zA-Z0-9\-%\s\+]+)" uri)
        op-id (form-decode op-id-raw)
        log   (try (slurp (str "/tmp/nos-logs/" flow-id "/" op-id ".txt"))
                   (catch Exception e nil))]
    (if (and flow-id op-id log)
      {:status  200
       :headers {"content-type" "text/plain"}
       :body log}
      {:status  404
       :headers {"content-type" "text/plain"}
       :body    "Not found"})))

(defn handler [{:keys [uri] :as request}]
  (cond
    (or (= uri "/health")
        (= uri "/"))
    {:status  200
     :headers {"content-type" "text/html"}
     :body    "OK"}
    (string/starts-with? uri "/nosana/logs/")
    (get-op-log uri)
    :else             {:status  404
                       :headers {"content-type" "text/html"}
                       :body    "Not found"}))

(defn use-jetty [{:keys [http/handler] :as system}]
  (let [server (jetty/run-jetty handler
                                {:host  "localhost"
                                 :port  3000
                                 :join? false})]
    (update system :system/stop conj #(.stop server))))
