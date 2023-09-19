(ns nosana-node.main
  (:require [nosana-node.nosana :as nosana :refer [use-nosana]]
            nosana-node.handler
            nos.ops.git
            [nosana-node.system :refer [start-system use-jetty use-when] :as nos-sys]
            [nosana-node.pipeline :as pipeline]
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
            [cider.nrepl :refer (cider-nrepl-handler)]
            [clojure.tools.cli :as cli])
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

(def cli-options
  [["-p" "--port PORT" "HTTP port"
    :parse-fn #(Integer/parseInt %)
    :validate [#(< 0 % 0x10000) "Must be a number between 0 and 65536"]]
   [nil "--ipfs-url URL" "IPFS url"]
   [nil "--podman URI" "Podman connection URI"
    :id :podman-conn-uri]
   [nil "--market ADDR" "Solana address of the market the node will join."
    :default-desc "$MARKET"
    :id :nosana-market]
   [nil "--pinata-jwt" "JWT used for communicating with Pinata."
    :default-desc "$PINATA_JWT"]
   ["-n" "--network NETWORK" "Network to run on"
    :default-desc "$SOLANA_NETWORK"
    :parse-fn #(keyword %)
    :id :solana-network]
   [nil "--branch REF"
    "Git branch to checkout when running a pipeline locally. If not set will use HEAD and include staged changes."
    :id :git-branch]
   ["-v" nil "Use verbose output (-vvvvv very verbose output)"
    :id :verbosity
    :default 4
    :default-desc ""
    :update-fn inc]
   ["-h" "--help"]])

(defn usage [options-summary]
  (->> ["Nosana Node"
        ""
        "Usage: nosana-node [options] action"
        ""
        "Options:"
        options-summary
        ""
        "Actions:"
        "  pipeline   Run a local pipeline"
        "  start      Start a node server"
        ""
        "Please refer to the docs for more information."]
       (string/join \newline)))

(defn use-cli
  "Parse CLI arguments using `tools.cli` and add to system map."
  [{:keys [cli-args nos/vault] :as sys}]

  (let [{:keys [errors options arguments summary] :as res}
        (cli/parse-opts cli-args cli-options)

        state (cond
                (:help options)
                {:exit-message (usage summary) :ok? true}
                :else
                options)]
    (cond
      (:exit-message state)
      (do
        (println (:exit-message state))
        (System/exit (if (:ok? state) 0 1)))

      :else
      (do
        ;; set logging level
        (let [{:keys [verbosity]} options
              log-level
              (nth (reverse [:trace :debug :info :warn :error
                             :fatal :report])
                   verbosity)]
          (log/set-min-level! log-level))

        ;; merge CLI over existing config
        (cond->
          (update sys :nos/vault merge state)
          (= "pipeline" (first arguments))
          (dissoc :run-server?))))))

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
