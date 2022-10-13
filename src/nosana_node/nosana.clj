(ns nosana-node.nosana
  (:require [integrant.core :as ig]
            [nos.core :as flow]
            [chime.core :as chime]
            [clojure.edn :as edn]
            [clj-http.client :as http]
            [clojure.core.async :as async :refer [<!! <! >!! put! go go-loop >! timeout take! chan]]
            [taoensso.timbre :as logg :refer [log]]
            [nos.vault :as vault]
            [chime.core-async :refer [chime-ch]]
            [konserve.core :as kv]
            [clojure.string :as string]
            [cheshire.core :as json]
            [clj-yaml.core :as yaml]
            [nosana-node.util
             :refer [ipfs-hash->bytes bytes->ipfs-hash]
             :as util]
            [nosana-node.solana :as sol])
  (:import java.util.Base64
           java.security.MessageDigest
           [java.time Instant Duration]
           [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
            Account Message AccountMeta]
           [org.p2p.solanaj.utils ByteUtils]
           [org.p2p.solanaj.rpc RpcClient Cluster]
           [org.bitcoinj.core Utils Base58]))

(def example-job
  {:type "Github"
   :url "https://github.com/nosana-ci/nosana.io"
   :commit "ef840c0614b0abd2de0816304febeff0296926e0"
   :pipeline "commands:\n  - yarn install --immutable\n  - yarn lint\n#  - yarn test:ci:storage-ui\n# docker image to run above commands\nimage: node"})

(def base-flow
  {:ops
   [{:op :nos.git/ensure-repo
     :id :clone
     :args [(flow/ref :input/repo) (flow/ref :input/path)]
     :deps []}
    {:op :nos.git/checkout
     :id :checkout
     :args [(flow/ref :clone) (flow/ref :input/commit-sha)]
     :deps []}]})

(defn hex->bytes [string]
  (javax.xml.bind.DatatypeConverter/parseHexBinary string))

(defn bytes->hex [arr]
  (javax.xml.bind.DatatypeConverter/printHexBinary arr))

(defn make-cli-ops [cmds podman-conn image]
  [{:op :docker/run
    :id :docker-cmds
    :args [{:cmd cmds
            :image image
            :conn {:uri [::flow/vault :podman-conn-uri]}
            :work-dir [::flow/str "/root" (flow/ref :checkout)]
            :resources [{:source (flow/ref :checkout) :dest "/root"}]
            }]
    :deps [:checkout]}])

;; (def ipfs-base-url "https://cloudflare-ipfs.com/ipfs/")
(def pinata-api-url "https://api.pinata.cloud")

(def nos-accounts
  {:mainnet {:nos-token   (PublicKey. "TSTntXiYheDFtAdQ1pNBM2QQncA22PCFLLRr53uBa8i")
             :stake       (PublicKey. "nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE")
             :collection  (PublicKey. "nftNgYSG5pbwL7kHeJ5NeDrX8c4KrG1CzWhEXT8RMJ3")
             :job         (PublicKey. "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM")
             :reward      (PublicKey. "nosRB8DUV67oLNrL45bo2pFLrmsWPiewe2Lk2DRNYCp")
             :pool        (PublicKey. "nosPdZrfDzND1LAR28FLMDEATUPK53K8xbRBXAirevD")
             :reward-pool (PublicKey. "mineHEHiHxWS8pVkNc5kFkrvv5a9xMVgRY9wfXtkMsS")
             :dummy       (PublicKey. "dumxV9afosyVJ5LNGUmeo4JpuajWXRJ9SH8Mc8B3cGn")}
   :devnet  {:nos-token   (PublicKey. "devr1BGQndEW5k5zfvG5FsLyZv1Ap73vNgAHcQ9sUVP")
             :stake       (PublicKey. "nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE")
             :collection  (PublicKey. "CBLH5YsCPhaQ79zDyzqxEMNMVrE5N7J6h4hrtYNahPLU")
             :job         (PublicKey. "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM")
             :reward      (PublicKey. "nosRB8DUV67oLNrL45bo2pFLrmsWPiewe2Lk2DRNYCp")
             :pool        (PublicKey. "nosPdZrfDzND1LAR28FLMDEATUPK53K8xbRBXAirevD")
             :reward-pool (PublicKey. "miF9saGY5WS747oia48WR3CMFZMAGG8xt6ajB7rdV3e")
             :dummy       (PublicKey. "dumxV9afosyVJ5LNGUmeo4JpuajWXRJ9SH8Mc8B3cGn")}})

(defn bytes-to-hex-str
  "Convert a seq of bytes into a hex encoded string."
  [bytes]
  (apply str (for [b bytes] (format "%02x" b))))



(def download-ipfs
  "Download a file from IPFS by its hash."
  (memoize
   (fn [hash {:keys [ipfs-url]}]
     (log :trace "Downloading IPFS file " hash)
     (-> (str ipfs-url hash) http/get :body (json/decode true)))))

(defn download-job-ipfs
  [bytes conf]
  (-> bytes
      byte-array
      bytes->ipfs-hash
      (download-ipfs conf)
      (update :pipeline yaml/parse-string)))

(defn sha256 [string]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") (.getBytes string "UTF-8"))]
    (apply str (map (partial format "%02x") digest))))

(defn hash-repo-url
  "Creates a short hash for a repo url"
  [name]
  (->> name sha256 (take 20) (reduce str)))

(defn make-job-flow [job job-addr run-addr]
  (let [new-flow (-> base-flow
                     (assoc-in [:results :input/repo] (:url job))
                     (assoc-in [:results :input/path] (str "/tmp/repos/"
                                                           (hash-repo-url (:url job))))
                     (assoc-in [:results :input/commit-sha] (:commit job))
                     (assoc-in [:results :input/job-addr] (.toString job-addr))
                     (assoc-in [:results :input/run-addr] (.toString run-addr))
                     (assoc-in [:results :input/commands] (:commands job))
                     (update :ops concat (make-cli-ops
                                          (-> job :pipeline :commands)
                                          {:uri "http://localhost:8080"}
                                          (-> job :pipeline :image))))
        last-op-id (-> new-flow :ops last :id)
        wrap-up-op {:op :fx :id :wrap-up :args [[:nos.nosana/complete-job]] :deps [last-op-id]}]
    (->
     new-flow
     (update :ops concat [wrap-up-op])
     (update :ops #(into [] %))
     flow/build)))

(defn get-signer-key
  "Retreive the signer key from the vault"
  [vault]
  (Account. (byte-array (edn/read-string (vault/get-secret vault :solana-private-key)))))

(defn solana-tx-failed?
  "Return true if a solana transaction failed

  This is when it contains an error object in its metadata"
  [tx]
  (-> tx :meta :err nil? not))



(defn ipfs-upload
  "Converts a map to a JSON string and pins it using Pinata"
  [obj {:keys [pinata-jwt]}]
  (log :trace "Uploading object to ipfs")
  (->
   (http/post (str pinata-api-url "/pinning/pinJSONToIPFS")
              {:headers {:Authorization (str "Bearer " pinata-jwt)}
               :content-type :json
               :body (json/encode obj)})
   :body
   json/decode
   (get "IpfsHash")))

(defn format-nos [v]
  (BigDecimal. (BigInteger. v)  6))

(defn get-health
  "Queuery health statistics for the node."
  [{:keys [address network nos-ata accounts]}]
  {:sol (sol/format-sol (str (sol/get-balance address network)))
   :nos (format-nos (sol/get-token-balance nos-ata network))
   :nft (Integer/parseInt (sol/get-token-balance (get accounts "nft") network))})

(def  min-sol-balance
  "Minimum Solana balance to be healthy" (sol/format-sol "100000000"))

(defn healthy
  "Check if the current node is healthy."
  [conf]
  (let [{:keys [sol nos nft] :as health} (get-health conf)]
    (cond
      (< sol min-sol-balance)
      [:error health (str "SOL balance is too low to operate.")]

      (< nft 1.0)
      [:error health (str "Burner Phone NFT is missing")]

      (nil? (:pinata-jwt conf))
      [:error health "Pinata JWT not found, node will not be able to submit any jobs."]

      :else [:success health])))

;; this coerces the flow results for Nosana and uploads them to IPFS. then
;; finalizes the Solana transactions for the job
(defmethod flow/handle-fx :nos.nosana/complete-job
  [{:keys [vault] :as fe} op fx flow]
  (let [end-time (flow/current-time)
        ;; here we collect the op IDs of which we want to include the results in
        ;; the final JSON
        op-ids (->> [:docker-cmds]
                    (concat [:clone :checkout]))
        ;; put the results of some operators in map to upload to IPFS. also
        ;; we'll slurp the content of the docker logs as they're only on the
        ;; local file system.
        res (-> flow :results
                (select-keys op-ids)
                (update-in [:docker-cmds]
                           (fn [[status results]]
                             (if (= status :error)
                               results
                               [status (map #(if (:log %) (update %
                                                                  :log
                                                                  (fn [l] (-> l slurp json/decode))) %) results)]))))
        job-result {:nos-id (:id flow)
                    :finished-at (flow/current-time)
                    :results res}
        _ (log :info "Uploading job result")
        ipfs (ipfs-upload job-result vault)]
    (log :info "Job results uploaded to " ipfs)
    (assoc-in flow [:results :result/ipfs] ipfs)))

(defn flow-finished? [flow]
  (contains? (:results flow) :result/ipfs))

(defn flow-git-failed?
  "Check if one of the git operations in a flow falied

  They are pre-requisite for the docker commands and we catch them separately"
  [flow]
  (or (= ::flow/error (get-in flow [:results :clone 0]))
      (= ::flow/error (get-in flow [:results :checkout 0]))))

(def ascii-logo "  _ __   ___  ___  __ _ _ __   __ _
 | '_ \\ / _ \\/ __|/ _` | '_ \\ / _` |
 | | | | (_) \\__ \\ (_| | | | | (_| |
 |_| |_|\\___/|___/\\__,_|_| |_|\\__,_|")

;;(nos/print-head "v0.3.19" "4HoZogbrDGwK6UsD1eMgkFKTNDyaqcfb2eodLLtS8NTx" "0.084275" "13,260.00")
(defn print-head [version address network balance stake nft owned]
  (logg/infof "
%s

Running Nosana Node %s

  Validator  \u001B[34m%s\u001B[0m
  Network    Solana \u001B[34m%s\u001B[0m
  Balance    \u001B[34m%s\u001B[0m SOL
  Stake      \u001B[34m%s\u001B[0m NOS
  Slashed    \u001B[34m0.00\u001B[0m NOS
  NFT        \u001B[34m%s\u001B[0m
  Owned      \u001B[34m%s\u001B[0m NFT
"
              ascii-logo
              version
              address
              network
              balance
              stake
              nft
              owned
              ))

(defn make-config
  "Build the node's config to interact with the Nosana Network."
  [{:keys [:nos/vault]}]
  (let [network      (:solana-network vault)
        signer       (get-signer-key vault)
        signer-pub   (.getPublicKey signer)
        programs     (network nos-accounts)
        market-pub   (PublicKey. (:nosana-market vault))
        market-vault (sol/pda
                      [(.toByteArray market-pub)
                       (.toByteArray (:nos-token programs))]
                      (:job programs))
        stake        (sol/pda
                      [(.getBytes "stake")
                       (.toByteArray (:nos-token programs))
                       (.toByteArray (.getPublicKey signer))]
                      (:stake programs))
        nft          (PublicKey. (:nft vault))
        nft-ata      (sol/get-ata signer-pub nft)
        nos-ata      (sol/get-ata signer-pub (:nos-token programs))
        dummy        (-> vault :dummy-private-key byte-array Account.)]
    {:network      network
     :signer       signer
     :dummy-signer dummy
     :pinata-jwt   (:pinata-jwt vault)
     :ipfs-url     (:ipfs-url vault)
     :dummy        (.getPublicKey dummy)
     :market       market-pub
     :address      signer-pub
     :programs     programs
     :nft          nft
     :nos-ata      nos-ata
     :stake-vault  (sol/pda [(.getBytes "vault")
                             (.toByteArray (:nos-token programs))
                             (.toByteArray signer-pub)]
                            (:stake programs))
     :accounts     {"tokenProgram"      (:token sol/addresses)
                    "systemProgram"     (:system sol/addresses)
                    "rent"              (:rent sol/addresses)
                    "accessKey"         (PublicKey. (:nft-collection vault))
                    "authority"         signer-pub
                    "user"              nos-ata
                    "payer"             signer-pub
                    "market"            market-pub
                    "mint"              (:nos-token programs)
                    "vault"             market-vault
                    "stake"             stake
                    "nft"               nft-ata
                    "metadata"          (sol/get-metadata-pda nft)
                    "rewardsProgram"    (:reward programs)
                    "rewardsVault"      (sol/pda [(.toByteArray (:nos-token programs))]
                                                 (:reward programs))
                    "rewardsReflection" (sol/pda [(.getBytes "reflection")]
                                                 (:reward programs))}}))

(defn build-idl-tx
  "Wrapper around `solana/build-idl-tx` using nosana config"
  [program ins args {:keys [network accounts]} extra-accounts]
  (sol/build-idl-tx
   (-> nos-accounts network program)
   ins
   args
   (merge accounts extra-accounts)
   network))

(defn list-job
  "List a job, assuming there are nodes in the queue"
  [conf job]
  (let [hash (ipfs-upload job conf)
        job  (sol/account)
        run  (sol/account)
        tx   (build-idl-tx :job "list" [(ipfs-hash->bytes hash)]
                           conf {"job" (.getPublicKey job)
                                 "run" (.getPublicKey run)})]
    (log :info "Listing job with hash " (-> job .getPublicKey .toString) hash)
    (sol/send-tx tx [(:signer conf) job run] (:network conf))))

(defn enter-market
  "Enter market, assuming there are no jobs in the queue."
  [conf]
  (let [run (Account.)
        tx  (build-idl-tx :job "work" []
                          conf {"run" (.getPublicKey run)})]
    (sol/send-tx tx [(:signer conf) run] (:network conf))))

(defn get-job [{:keys [network programs]} addr]
  (sol/get-idl-account (:job programs) "JobAccount" addr network))

(defn get-run [{:keys [network programs]} addr]
  (sol/get-idl-account (:job programs) "RunAccount" addr network))

(defn finish-job
  "Post results for an owned job."
  [{:keys [network signer] :as conf} job-addr run-addr ipfs-hash]
  (let [run (get-run conf run-addr)]
    (-> (build-idl-tx :job "finish"
                      [(ipfs-hash->bytes ipfs-hash)]
                      conf
                      {"job"   job-addr
                       "run"   run-addr
                       "payer" (:payer run)})
        (sol/send-tx [signer] network))))
;; (let [[run-addr run] (first (nos/find-my-runs conf))] (nos/finish-job conf (:job run) (PublicKey.  run-addr) "QmSM84ChKhuAMMJr4B6gdU22smbkVjVhsVN4aN3rSNzLhX"))
(defn find-my-jobs
  "Find job accounts owned by this node"
  [{:keys [network programs address]}]
  (sol/get-idl-program-accounts
   network
   (:job programs)
   "JobAccount"
   {"node"  (.toString address)
    "state" "2"}))

(defn find-my-runs
  "Find job accounts owned by this node"
  [{:keys [network programs address]}]
  (sol/get-idl-program-accounts
   network
   (:job programs)
   "RunAccount"
   {"node"  (.toString address)}))

(defn get-market [{:keys [network programs market]}]
  (sol/get-idl-account (:job programs) "MarketAccount" market network))

(defn is-queued? [conf]
  (let [market (get-market conf)]
    (not-empty (filter #(.equals %1 (:address conf)) (:queue market)))))

(defn process-flow!
  "Check the state of a flow and finalize its job if finished.
  Returns nil if successful, `flow-id` if not finished or if an
  exception occured."
  [flow-id conf {:nos/keys [store flow-chan vault]}]
  (go
    (try
      (let [flow (<! (kv/get store flow-id))
            ;; TODO: here we manually detect a flow failure and trigger
            ;; an FX and then restore the flow. this should be handled
            ;; by Nostromo error handlers when implemented there.
            flow (if (flow-git-failed? flow)
                   (flow/handle-fx {:store store :chan flow-chan :vault vault}
                                   nil
                                   [:nos.nosana/complete-job]
                                   flow)
                   flow)
            _    (<! (kv/assoc store flow-id flow))]
        (if (flow-finished? flow)
          (let [_           (log :info "Flow finished, posting results")
                job-addr    (get-in flow [:results :input/job-addr])
                run-addr    (get-in flow [:results :input/run-addr])
                result-ipfs (get-in flow [:results :result/ipfs])
                sig         (finish-job conf (PublicKey. job-addr) (PublicKey. run-addr) result-ipfs)
                tx          (<! (sol/await-tx< sig (:network conf)))]
            (log :info "Job results posted " result-ipfs sig)
            nil)
          (let [_ (log :trace "Flow still running")]
            flow-id)))
      (catch Exception e
        (log :error "Failed processing flow " e)
        flow-id))))

(defn job->flow
  "Create a flow data structure for a job."
  [job-pub run-pub conf]
  (let [job      (get-job conf job-pub)
        job-info (download-job-ipfs (:ipfsJob job) conf)]
    (make-job-flow job-info job-pub run-pub)))

(defn start-flow-for-run!
  "Start running a new Nostromo flow and return its flow ID."
  [[run-addr run] conf {:keys [:nos/store :nos/flow-chan]}]
  (let [flow    (job->flow (:job run) run-addr conf)
        flow-id (:id flow)]
    (log :info "Starting job" (-> run :job .toString ))
    (log :trace "Processing flow" flow-id)
    (go
      (<! (flow/save-flow flow store))
      (>! flow-chan [:trigger flow-id])
      flow-id)))

(defn work-loop
  "Main loop."
  [conf {:nos/keys [jobs] :as system}]
  (go-loop [active-flow nil]
    (async/alt!
      ;; put anything on :exit-ch to stop the loop
      (:exit-chan jobs) nil
      ;; otherwise we will loop onwards with a timeout
      (timeout (:poll-delay jobs))
      (let [runs (find-my-runs conf)]
        (cond
          active-flow       (do
                              (log :info "Checking progress of flow " active-flow)
                              (recur (<! (process-flow! active-flow conf system))))
          (not-empty runs)  (do
                              (log :info "Found claimed jobs to work on")
                              (recur (<! (start-flow-for-run! (first runs) conf system))))
          (is-queued? conf) (do
                              (log :info "Waiting in the queue")
                              (recur nil))
          :else             (do
                              (log :info "Entering the queue")
                              (sol/await-tx< (enter-market conf) (:network conf))
                              (recur nil)))))))

(derive :nos/jobs :duct/daemon)
(derive :nos.nosana/complete-job ::flow/fx)



(defmethod ig/init-key :nos/jobs
  [_ {:keys [store flow-ch vault]}]
  (let [system     {:nos/store     store
                    :nos/flow-chan flow-ch
                    :nos/vault     vault}
        network    (:solana-network vault)
        market     (:nosana-market vault)
        conf       (make-config system)
        market-acc (get-market conf)
        exit-ch    (chan)

        [status health msg] (healthy conf)]

    (print-head
     ;; TODO: version from env
     "v0.3.19"
     (:address conf)
     (:network conf)
     (-> health :sol)
     (-> health :nos)
     (:nft conf)
     (-> health :nft))

    (case status
      :success (println "Node started. LFG.")
      :error   (println "\u001B[31mNode not healthy:\u001B[0m " msg))

    ;; put any value to `exit-ch` to cancel the `loop-ch`:
    ;; (async/put! exit-ch true)
    {:loop-ch    (when (and (:start-job-loop? vault) (= :success status))
                   (work-loop conf system))
     :exit-chan  (chan)
     :poll-delay (:poll-delay-ms vault)}))

(defmethod ig/halt-key! :nos/jobs
  [_ {:keys [loop-chan refresh-jobs-chime exit-chan project-addrs]}]
  (put! exit-chan true))
