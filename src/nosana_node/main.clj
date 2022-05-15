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
            [cider.nrepl :refer (cider-nrepl-handler)]            )
  (:gen-class))

(duct/load-hierarchy)

(defmethod ig/init-key :nosana-node/nrepl-server [_ {:keys [port] :or {port 7888}}]
  (nrepl-server/start-server :port port :handler cider-nrepl-handler))

(defmethod ig/halt-key! :nosana-node/nrepl-server [_ {:keys [server-socket]}]
  (.close server-socket))

(defn -main [& args]
  (println "Starting system")
  (let [keys [:duct/daemon]
        profiles [:duct.profile/prod]]
    (-> (duct/resource "nosana/duct_config.edn")
        (duct/read-config)
        (duct/exec-config profiles keys))))
