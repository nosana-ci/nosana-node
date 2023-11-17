(ns nosana-node.main
  (:require [nosana-node.nosana :as nosana :refer [use-nosana]]
            nosana-node.handler
            nos.ops.git
            [nos.core :as flow]
            [nosana-node.system :refer [start-system use-jetty use-when] :as nos-sys]
            [nosana-node.pipeline :as pipeline]
            [nosana-node.cli :as cli]
            nosana-node.gitlab
            nos.ops.docker
            [nos.store :as store]
            [nos.vault :refer [use-vault]]
            [nos.system :refer [use-nostromo]]
            nos.module.http
            [clojure.java.io :as io]
            [taoensso.timbre :as log]
            [integrant.core :as ig]
            [clojure.string :as string]
            [nrepl.server :as nrepl-server]
            [cider.nrepl :refer (cider-nrepl-handler)])
  (:gen-class))

(defonce system (atom nil))

(defn make-fe
  "Create the `flow-engine` object as expected by Nostromo from the
  system. Helper function is useful from the repl."
  []
  {:nos/store (:nos/store @system)
   :chan (:nos/flow-chan @system)
   :vault (:nos/vault @system)})

(defn use-nrepl [system]
  (let [port   7888
        socket (nrepl-server/start-server
                :bind "0.0.0.0"
                :port port
                :handler cider-nrepl-handler)]
    (log/info "Started nrepl server on port " port)
    (update system :system/stop conj #(.close socket))))

(defn use-pipeline [{:keys [nos/vault] :as system}]
  (let [dir (System/getProperty "user.dir")]
    (try
      (pipeline/run-local-pipeline dir (:nos/vault system))
      (catch Exception e
        (println "Error: " (ex-message e))))))

(defn -main [& args]
  (try
    (start-system
     system
     {:http/handler      #'nos-sys/handler
      :system/components [use-vault
                          use-cli
                          store/use-fs-store
                          (use-when :run-server?
                                    use-nrepl
                                    use-nostromo
                                    use-nosana
                                    nos-sys/use-wrap-ctx
                                    use-jetty)
                          (use-when #(not (:run-server? %))
                                    use-pipeline)]
      :system/profile    :prod
      :run-server?       true
      :cli-args          args
      :nos/log-dir       "/tmp/logs"
      :nos/store-path    "/tmp/store"
      :nos/vault-path    (io/resource "config.edn")})
    (catch Exception e
      (do
        (log/log :trace e)
        (println (ex-message e))))))
