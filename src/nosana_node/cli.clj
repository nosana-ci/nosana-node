(ns nosana-node.cli
  (:require [taoensso.timbre :as log]
            [clojure.string :as string]
            [clojure.tools.cli :as cli]))

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
  "Parse CLI arguments using `tools.cli` and add to system map.

  The `:id` and value of each attribute is merged into the `:nos/vault`
  map in the system."
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
