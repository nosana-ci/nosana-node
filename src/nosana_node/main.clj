(ns nosana-node.main
  (:require
   [taoensso.timbre :as log])
  (:gen-class))

;; first set the logging level so we can suprress debug logs generated
;; by importing org.eclipse.jetty.util.log
(log/set-min-level! :warn)

(ns nosana-node.main
  (:require
   [nosana-node.nosana :as nosana :refer [use-nosana work-loop]]
   [nos.core :as flow]
   [clojure.core.async :refer [<!!]]
   [nosana-node.system :refer [start-system use-when] :as nos-sys]
   [nosana-node.pipeline :as pipeline]
   [nosana-node.cli :as cli]
   nosana-node.gitlab
   nos.ops.docker
   [nos.store :as store]
   [nosana-node.join-test-grid :refer [join-test-grid]]
   [nos.vault :refer [use-vault]]
   [nos.system :refer [use-nostromo]]
   [clojure.java.io :as io]
   [clojure.string :as string]))

(defonce system (atom nil))

(defn make-fe
  "Create the `flow-engine` object as expected by Nostromo from the
  system. Helper function is useful from the repl."
  []
  {:nos/store (:nos/store @system)
   :chan (:nos/flow-chan @system)
   :vault (:nos/vault @system)})

(defn use-pipeline [{:keys [nos/vault] :as system}]
  (let [dir (System/getProperty "user.dir")]
    (try
      (pipeline/run-local-pipeline dir (:nos/vault system))
      (catch Exception e
        (println "Error: " (ex-message e))))))

(defn -main [& args]
  (try
    (let [sys
          (start-system
           system
           {:http/handler       #'nos-sys/handler
            :system/components  [use-vault
                                cli/use-cli
                                store/use-fs-store
                                 ;; use-nrepl
                                 use-nostromo
                                 use-nosana
                                 nos-sys/use-wrap-ctx]
            :system/profile     :prod
            :cli-args           args
            :run-server?        true
            :nos/log-dir        "/tmp/logs"
            :nos/store-path     "/tmp/store"
            :nos/start-job-loop true
            :nos/vault-path     (io/resource "config.edn")})]
      (case (:nos/action sys)
        "start" (<!! (work-loop sys))
        "join-test-grid" (<!! (join-test-grid sys))))
    (catch Exception e
      (do
        (log/log :trace e)
        (println (ex-message e))))))
