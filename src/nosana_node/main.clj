(ns nosana-node.main
  (:require
   [taoensso.timbre :as log])
  (:gen-class))

;; first set the logging level so we can suprress debug logs generated
;; by importing org.eclipse.jetty.util.log
(log/set-min-level! :warn)

(ns nosana-node.main
  (:require
   [nosana-node.nosana :as nosana :refer [use-nosana work-loop
                                          use-create-ata-and-stake]]
   [nos.core :as flow]
   [clojure.core.async :refer [<!!]]
   [nosana-node.system :refer [start-system use-when use-jetty use-nrepl] :as nos-sys]
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
                                 ;; nrepl is useful for debugging,
                                 ;; make config later
                                 (use-when (constantly false)
                                           use-nrepl)
                                 (use-when :run-server?
                                           use-jetty)
                                 ;; we change the log level after
                                 ;; jetty, as it prints a lot of INFO
                                 cli/use-set-log-level
                                 use-nostromo
                                 use-nosana
                                 use-create-ata-and-stake
                                 nos-sys/use-wrap-ctx]
            :system/profile     :prod
            :cli-args           args
            :run-server?        true
            :nos/log-dir        "/tmp/logs"
            :nos/store-path     "/tmp/store"
            :nos/start-job-loop true
            :nos/vault-path     (io/resource "config.edn")})]
      ;; :nos/action is the CLI action invoked, as parsed by `use-cli`
      (case (:nos/action sys)
        "start" (<!! (work-loop sys))
        "join-test-grid" (<!! (join-test-grid sys))))
    (catch Exception e
      (do
        (log/log :trace e)
        (println (ex-message e))
        (System/exit 1)))))
