 (ns nosana-node.cli
  (:require [taoensso.timbre :as log]
            [clojure.string :as string]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.tools.cli :as cli]))

(defn get-env-fn
  ([e default parse-fn] (fn [_] (let [env (System/getenv e)]
                                  (if env
                                    (parse-fn env)
                                    default))))
  ([e default] (fn [_] (or (System/getenv e) default)))
  ([e] (fn [_] (System/getenv e))))

;; contains the cli option configuration for the different commands
(def cli-options
  {;; global CLI options
   nil
   {:options
    [[nil "--ipfs-url URL" "IPFS url"
      :default-fn (get-env-fn "IPFS_URL" "https://nosana.mypinata.cloud/ipfs/")]
     [nil "--podman URI" "Podman connection URI"
      :default-fn (get-env-fn "PODMAN_CONN_URI" "http://localhost:8080")
      :default-desc "http://localhost:8080"
      :id :podman-conn-uri]
     [nil "--pinata-jwt JWT" "JWT used for communicating with Pinata."
      :default-fn (fn [_] (or (System/getenv "PINATA_JWT")
                              (edn/read-string (slurp "https://app.nosana.ci/pinata"))))]
     [nil "--nft ADDR" "Address of the NFT to use for accessing the market"
      :default-fn (get-env-fn "NOSANA_NFT")
      :id :nft]
     ["-n" "--network NETWORK" "Solana network to run on (mainnet or devnet)"
      :default-fn (get-env-fn "SOLANA_NETWORK" :mainnet #(keyword %))
      :parse-fn #(keyword %)
      :id :solana-network]
     ["-w" "--wallet PATH" "Path to wallet private key"
      :default-fn (fn [_]
                    (or (System/getenv "SOLANA_PRIVATE_KEY")
                        (slurp (str (System/getenv "HOME") "/nosana_key.json"))))
      :default-desc "~/nosana_key.json"
      :parse-fn slurp
      :id :solana-private-key]
     ["-v" nil "Use verbose output (-vvvvv very verbose output)"
      :id :verbosity
      :default 4
      :default-desc ""
      :update-fn inc]
     ["-h" "--help"]]

    :usage
    (fn [options-summary]
      ["Nosana Node"
       ""
       "Usage: nosana-node [options] action"
       ""
       "Options:"
       options-summary
       ""
       "Actions:"
       "  start                 Start the Nosana node server"
       "  join-test-grid        Register for the Nosana Test Grid"
       ""
       "Please refer to the docs for more information."])}

   "start"
   {:options
    [["-p" "--port PORT" "HTTP port"
      :default-desc "3000"
      :default-fn (get-env-fn "PORT" 3000)
      :parse-fn #(Integer/parseInt %)
      :validate [#(< 0 % 0x10000) "Must be a number between 0 and 65536"]]
     [nil "--market ADDR" "Solana address of the market the node will join."
      :default-desc ""
      :default-fn (get-env-fn "NOSANA_MARKET")
      :id :nosana-market]
     [nil "--poll-frequency MS" "How often to poll the blockchain in milliseconds."
      :parse-fn #(Integer/parseInt %)
      :default-desc "5000"
      :default-fn (get-env-fn "NOSANA_POLL_DELAY_MS" 5000)
      :validate [#(< 3000 % 60000) "Must be a number between 3000 and 60000"]
      :id :poll-delay-ms]
      ["-h" "--help"]]

    :usage
    (fn [options-summary]
      ["Usage: nosana-node start [options]"
       ""
       "Start a Node server to work on the Nosana Network."
       ""
       "Options:"
       options-summary])}

   "join-test-grid"
   {:options
    [["-h" "--help"]]

    :usage
    (fn [options-summary]
      ["Usage: nosana-node join-test-grid [options]"
       ""
       "Register for the Nosana Test Grid."
       ""
       "Options:"
       options-summary])}})

;; set of the allowed CLI actions
(def cli-actions (-> cli-options keys set (disj nil)))

(defn usage
  "Format the help message for a specific command.
  `options-summary` is normally generated by `tools-cli/parse-opts`."
  [command options-summary]
  (->> ((get-in cli-options [command :usage]) options-summary)
       (string/join \newline)))

(defn error-msg
  "Format the error message give a list of `errors`."
  [errors]
  (str "The following errors occurred while parsing your command:\n\n"
       (string/join \newline errors)))

(def env-config
  {:nosana-market "NOSANA_MARKET"
   :pinata-jwt "PINATA_JWT"
   :nft "NOSANA_NFT"
   :solana-network "SOLANA_NETWORK"
   :ipfs-url "IPFS_URL"
   :poll-delay-ms "NOSANA_POLL_DELAY_MS"
   :podman-conn-uri "PODMAN_CONN_URI"})

(defn read-environment-config
  "Load the configuration from environment variables.
  This is currently not used in favor of `tools.cli`'s `:default-fn`"
  []
  (reduce
   (fn [conf-map [conf-key env-var]]
     (let [env-val (System/getenv env-var)]
       (if env-val
         (assoc conf-map conf-key env-val)
         conf-map)))
   {}
   env-config))

(defn validate-config
  [action options]
  (cond
    ))



(defn use-cli
  "Parse CLI arguments using `tools.cli` and add to system map.

  The `:id` and value of each attribute is merged into the `:nos/vault`
  map in the system."
  [{:keys [cli-args nos/vault] :as sys}]
  (let [{:keys [errors options arguments summary] :as res}
        (cli/parse-opts cli-args (get-in cli-options [nil :options]) :in-order true)

        action (or (first arguments) "start")

        state (cond
                (:help options)
                {:exit-message (usage nil summary) :ok? true}

                errors
                {:exit-message (error-msg errors)}

                (not (contains? cli-actions action))
                {:exit-message (str "Unknown action " action) :ok? false}

                ;; parse the arguments for this action
                :else
                (let [{a-summary :summary a-errors :errors a-args :arguments a-options :options}
                      (cli/parse-opts (rest arguments) (get-in cli-options [action :options]))]
                  (cond
                    (:help a-options)
                    {:exit-message (usage action a-summary) :ok? true}

                    a-errors
                    {:exit-message (error-msg a-errors)}

                    :else
                    (merge options a-options))))]

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
          (log/set-min-level! log-level)
          (log/debug "Log level is " log-level))

        ;; merge CLI over existing config
        (cond->
          (update sys :nos/vault merge state)
          (= "start" action)
          (assoc :run-server? true
                 :nos/start-job-loop? true))))))
