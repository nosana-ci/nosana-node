(ns nosana-node.main
  (:require [nosana-node.nosana :as nosana]
            nosana-node.handler
            nos.ops.git
            nos.ops.docker
            nos.system
            nos.module.http
            [duct.core :as duct]
            [integrant.core :as ig]
            [nrepl.server :as nrepl-server]
            [cider.nrepl :refer (cider-nrepl-handler)])
  (:gen-class))

;; keep track of the global system so we can access it in the repl
(defonce global-system (atom nil))

(defmethod ig/init-key :nosana-node/nrepl-server [_ {:keys [port] :or {port 7888}}]
  (println ">> Starting nrepl server on port " port)
  (nrepl-server/start-server :port port :handler cider-nrepl-handler))

(defmethod ig/halt-key! :nosana-node/nrepl-server [_ {:keys [server-socket]}]
  (.close server-socket))

(derive :nosana-node/nrepl-server :duct/daemon)

(duct/load-hierarchy)

(defn -main [& args]
  (println "Starting system")
  (let [keys [:duct/daemon]
        profiles [:duct.profile/prod]
        system (-> (duct/resource "nosana/duct_config.edn")
                   (duct/read-config)
                   (duct/prep-config profiles)
                   (ig/init keys))]
    (reset! global-system system)
    (duct/await-daemons system)))
