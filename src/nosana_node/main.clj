(ns nosana-node.main
  (:require [nosana-node.nosana :as nosana :refer [use-nosana]]
            nosana-node.handler
            nos.ops.git
            [nosana-node.system :refer [start-system use-jetty] :as nos-sys]
            nosana-node.gitlab
            nos.ops.docker
            [nos.store :as store]
            [nos.vault :refer [use-vault]]
            [nos.system :refer [use-nostromo]]
            nos.module.http
            [clojure.java.io :as io]
            [taoensso.timbre :as log]
            [integrant.core :as ig]
            [nrepl.server :as nrepl-server]
            [cider.nrepl :refer (cider-nrepl-handler)])
  (:gen-class))

(defonce system (atom nil))

(defn use-nrepl [system]
  (let [port   7888
        socket (nrepl-server/start-server
                :bind "0.0.0.0"
                :port port
                :handler cider-nrepl-handler)]
    (log/info "Started nrepl server on port " port)
    (update system :system/stop conj #(.close socket))))

(defn -main [& args]
  (start-system
   system
   {:http/handler      #'nos-sys/handler
    :system/components [use-vault
                        use-jetty
                        store/use-fs-store
                        use-nostromo
                        use-nosana]
    :system/profile    :prod
    :nos/log-dir       "/tmp/logs"
    :nos/store-path    "/tmp/store"
    :nos/vault-path    (io/resource "config.edn")}))
