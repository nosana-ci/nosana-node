(ns nosana-node.main
  (:require [nosana-node.nosana :as nosana]
            nosana-node.handler nos.system
            [duct.core :as duct])
  (:gen-class))

(duct/load-hierarchy)

(defn -main [& args]
  (println "Starting system")
  (let [keys [:duct/daemon]
        profiles [:duct.profile/prod]]
    (-> (duct/resource "nosana/duct_config.edn")
        (duct/read-config)
        (duct/exec-config profiles keys))))
