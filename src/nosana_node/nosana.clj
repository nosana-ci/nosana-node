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
            [nosana-node.util :as util]
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
(def ipfs-base-url "https://nosana.mypinata.cloud/ipfs/")
(def pinata-api-url "https://api.pinata.cloud")

(defn str->base64 [string] (.encodeToString (Base64/getEncoder) (.getBytes string)))
(defn base64->bytes [base64] (.decode (Base64/getDecoder) base64))

(def sol-rpc {:testnet "https://api.testnet.solana.com"
              :devnet "https://api.devnet.solana.com"
              :mainnet "https://solana-api.projectserum.com"})

(defn public-key->bytes [pub]
  (.toByteArray (PublicKey. pub)))

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

(def system-program (PublicKey. "11111111111111111111111111111111"))
(def rent-program (PublicKey. "SysvarRent111111111111111111111111111111111"))
(def clock-addr (PublicKey. "SysvarC1ock11111111111111111111111111111111"))

(def job-acc (Account.))

(defn bytes-to-hex-str
  "Convert a seq of bytes into a hex encoded string."
  [bytes]
  (apply str (for [b bytes] (format "%02x" b))))

(defn ipfs-bytes->ipfs-hash
  "Convert the ipfs bytes from a solana job to a CID

  It prepends the 0x1220 to make it 34 bytes and Base58 encodes it. This result
  is IPFS addressable."
  [bytes]
  (->>  bytes bytes->hex (str "1220") hex->bytes Base58/encode ))

(defn ipfs-hash->job-bytes
  "Convert IPFS hash to a jobs byte array

  It Base58 decodes the hash and drops the first 2 bytes as they are static for
  our IPFS hashses (0x1220, the 0x12 means Sha256 and 0x20 means 256 bits)"
  [hash]
  (->> hash Base58/decode (drop 2) byte-array))

;; (defn sol-finish-job-tx [job-addr ipfs-hash signer-addr network]
;;   (let [job-key (PublicKey. job-addr)
;;         get-addr #(-> nos-config network %)
;;         keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. job-key false true))            ; job
;;                (.add (AccountMeta. (vault-ata-addr network) false true))     ; vault-ata
;;                (.add (AccountMeta. (get-addr :signer-ata) false true))    ; ataTo
;;                (.add (AccountMeta. signer-addr true false))        ; authority
;;                (.add (AccountMeta. token-program-id false false))  ; token
;;                (.add (AccountMeta. clock-addr false false))        ; clock
;;                )
;;         data (byte-array (repeat (+ 8 1 32) (byte 0)))
;;         ins-idx (byte-array (javax.xml.bind.DatatypeConverter/parseHexBinary "73d976b04fcbc8c2"))]
;;     (System/iarraycopy ins-idx 0 data 0 8)
;;     (aset-byte data 8 (unchecked-byte (.getNonce (vault-derived-addr network))))
;;     (System/arraycopy (ipfs-hash->job-bytes ipfs-hash) 0 data 9 32)
;;     (let [txi (TransactionInstruction. (get-addr :job) keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

;; (defn sol-claim-job-instruction [jobs-addr job-addr signer-addr network]
;;   (let [get-addr #(-> nos-config network %)
;;         keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. (PublicKey. jobs-addr) false true))         ; jobs
;;                (.add (AccountMeta. (PublicKey. job-addr) false true))         ; job
;;                (.add (AccountMeta. signer-addr true false))     ; authority
;;                (.add (AccountMeta. clock-addr false false))     ; clock
;;                )
;;         data (byte-array (repeat (+ 8) (byte 0)))
;;         ins-idx (byte-array (hex->bytes "09a005e7747bc60e"))]
;;     (System/arraycopy ins-idx 0 data 0 8)
;;     (let [txi (TransactionInstruction. (get-addr :job) keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

;; (defn sol-reclaim-job-instruction [job-addr signer-addr network]
;;   (let [get-addr #(-> nos-config network %)
;;         keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. (PublicKey. job-addr) false true))         ; job
;;                (.add (AccountMeta. signer-addr true false))     ; authority
;;                (.add (AccountMeta. clock-addr false false))     ; clock
;;                )
;;         data (byte-array (repeat (+ 8) (byte 0)))
;;         ins-idx (byte-array (hex->bytes (:reclaim-job instruction->idx)))]
;;     (System/arraycopy ins-idx 0 data 0 8)
;;     (let [txi (TransactionInstruction. (get-addr :job) keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

;; Example how to print a raw transaction
;; (defn print-raw-tx! [signer]
;;   ;; (prn "nonce: "   (.getNonce vault-derived-addr ))

;;   (let [;;client (RpcClient. "http://localhost:8899")
;;         client (RpcClient. (:testnet sol-rpc))
;;         api (.getApi client)
;;         ;; tx (sol-create-job-instruction)
;;         block-hash (.getRecentBlockhash api)
;;         tx (doto (sol-reclaim-job-instruction
;;                   "22111111111111111111111111111122"
;;                   "33111111111111111111111111111133"
;;                   (.getPublicKey signer) :mainnet)
;;              (.setRecentBlockHash block-hash)
;;              (.sign [signer])
;;              )
;;         _ (prn "bh: " block-hash)
;;         _ (prn(bytes-to-hex-str (Base58/decode block-hash)))
;;         _ (prn (bytes-to-hex-str (.serialize tx)))
;;         ;; sig (.sendTransaction api tx [signer-acc])
;;         ]
;;     ;;sig
;;     nil
;;     ))

;; (defn claim-job-tx! [jobs-addr job-addr signer network]
;;   (let [client (RpcClient. (get sol-rpc network))
;;         api (.getApi client)
;;         block-hash (.getRecentBlockhash api)
;;         tx (doto (sol-claim-job-instruction jobs-addr job-addr (.getPublicKey signer) network))
;;         sig (.sendTransaction api tx [signer])]
;;     sig))

;; (defn reclaim-job-tx! [job-addr signer network]
;;   (let [client (RpcClient. (get sol-rpc network))
;;         api (.getApi client)
;;         block-hash (.getRecentBlockhash api)
;;         tx (doto (sol-reclaim-job-instruction job-addr (.getPublicKey signer) network))
;;         sig (.sendTransaction api tx [signer])]
;;     sig))

;; (defn finish-job-tx! [job-addr result-ipfs signer network]
;;   (let [client (RpcClient. (get sol-rpc network))
;;         api (.getApi client)
;;         block-hash (.getRecentBlockhash api)
;;         tx (doto (sol-finish-job-tx job-addr result-ipfs (.getPublicKey signer) network))
;;         sig (.sendTransaction api tx [signer])]
;;     sig))

(def download-ipfs
  "Download a file from IPFS by its hash."
  (memoize
   (fn [hash]
     (log :trace "Downloading IPFS file " hash)
     (-> (str ipfs-base-url hash) http/get :body (json/decode true)))))

(defn download-job-ipfs
  [bytes]
  (-> bytes
      byte-array
      ipfs-bytes->ipfs-hash
      download-ipfs
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

(defn make-job-flow-ipfs [job-ipfs job-addr]
  (let [job (download-job-ipfs job-ipfs)]
    (make-job-flow job job-addr)))

(defn pick-job
  "Picks a single job from a sequence of jobs queues

  `job-addrs` is a sequence of Nosana jobs queues. The queues and their jobs are
  fetched depth-first until a job is found with status unclaimed."
  [job-addrs network]
  (loop [remaining-queues (shuffle job-addrs)]
    (log :info "... Picking jobs " remaining-queues)
    ;; (when (not-empty remaining-queues)
    ;;   (if-let [jobs (try
    ;;                   (-> remaining-queues first (get-jobs network))
    ;;                   (catch Exception e []))]
    ;;     (do
    ;;       (log :info "... Fetched jobs results is " jobs)
    ;;       (if (empty? (:jobs jobs))
    ;;         (recur (rest remaining-queues))
    ;;         (loop [job-addr (first (:jobs jobs))]
    ;;           (log :info "... Getting job " job-addr)
    ;;           (let [job (get-job job-addr network)]
    ;;             (log :info "... Resulted job info is " job)
    ;;             (if (or (= (:status job) 0))
    ;;               [(:addr jobs) job]
    ;;               (recur (rest (:jobs jobs))))))))))
    ))

(defn get-signer-key
  "Retreive the signer key from the vault"
  [vault]
  (Account. (byte-array (edn/read-string (vault/get-secret vault :solana-private-key)))))

(defn solana-tx-failed?
  "Return true if a solana transaction failed

  This is when it contains an error object in its metadata"
  [tx]
  (-> tx :meta :err nil? not))

(defn poll-nosana-job<
  "Pick, claim, and execute one job from `job-addrs`

  Returns the ID of the nostromo flow initiated when executing the job. If the
  Solana transaction fails or no suitable job was found return `nil`."
  [store flow-ch vault jobs-addrs network]
  (go
    ;; (when-let [[job-flow claim-sig]
    ;;            (<! (async/thread
    ;;                  (when-let [[jobs-addr job] (pick-job jobs-addrs network)]
    ;;                    (log :info "Trying job " (:addr job) " CID " (:job-ipfs job))
    ;;                    (let [job-flow (make-job-flow-ipfs (:job-ipfs job) (:addr job))
    ;;                          _ (log :info ".. Made job flow")
    ;;                          claim-sig (try
    ;;                                      (claim-job-tx! jobs-addr (:addr job) (get-signer-key vault) network)
    ;;                                      (catch Exception e
    ;;                                        (log :error "Claim job transaction failed." (ex-message e))
    ;;                                        nil))]
    ;;                      [job-flow claim-sig]))))]
    ;;   (when claim-sig
    ;;     (when-let [tx (<! (get-solana-tx< claim-sig 2000 30 network))]
    ;;       (if (not (solana-tx-failed? tx))
    ;;         (do
    ;;           (log :info "Job claimed. Starting flow " (:id job-flow))
    ;;           (<! (flow/save-flow job-flow store))
    ;;           (>! flow-ch [:trigger (:id job-flow)])
    ;;           (:id job-flow))
    ;;         (log :info "Job already claimed by someone else.")))))
    ))

;; (defn reclaim-nosana-job<
;;   "Pick, reclaim and exeucte one job from `claim-addrs`"
;;   [store flow-ch vault claim-addrs network]
;;   (go
;;     (when (not (empty? claim-addrs))
;;       (when-let [[job-flow claim-sig job-addr]
;;                  (<! (async/thread
;;                        (when-let [job (get-job (rand-nth claim-addrs) network)]
;;                          (log :info "Trying job " (:addr job) " CID " (:job-ipfs job))
;;                          (let [job-flow (make-job-flow-ipfs (:job-ipfs job) (:addr job))
;;                                _ (log :info ".. Made job flow")
;;                                claim-sig (try
;;                                            (reclaim-job-tx! (:addr job) (get-signer-key vault) network)
;;                                            (catch Exception e
;;                                              (log :error "Reclaim job transaction failed." (ex-message e))
;;                                              nil))]
;;                            [job-flow claim-sig (:addr job)]))))]
;;         (when claim-sig
;;           (when-let [tx (<! (get-solana-tx< claim-sig 2000 30 network))]
;;             (if (not (solana-tx-failed? tx))
;;               (do
;;                 (log :info "Job reclaimed" job-addr)
;;                 (refresh-backend-job-status (:nosana-job-status-refresh-url vault) job-addr)
;;                 (log :info "Job status refreshed in backend.")
;;                 (log :info "Starting flow" (:id job-flow))
;;                 (<! (flow/save-flow job-flow store))
;;                 (>! flow-ch [:trigger (:id job-flow)])
;;                 (:id job-flow))
;; (log :info "Job already reclaimed by someone else."))))))))

(derive :nos.nosana/complete-job ::flow/fx)

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

(defn get-health
  "Queuery health statistics for the node."
  [{:keys [address network nos-ata accounts]}]
  {:sol (sol/get-balance address network)
   :nos (sol/get-token-balance nos-ata network)
   :nft (sol/get-token-balance (get accounts "nft") network)})

(def  min-sol-balance
  "Minimum Solana balance to be healthy" 100000000)

(defn healthy
  "Check if the current node is healthy."
  [config]
  (let [{:keys [sol nos nft] :as health} (get-health config)]
    (cond
      (< sol min-sol-balance) [:error (str "The SOL balance is too low
      to operate: " sol)]
      (< nft 1.0)             [:error (str "NFT is missing")]
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

#_(defn poll-job-loop
  "Main loop for polling and executing Nosana jobs

  The loop ensures no jobs can be executed in parallel."
  ([store flow-ch vault job-addrs claim-addrs] (poll-job-loop store flow-ch vault job-addrs claim-addrs (chan)))
  ([store flow-ch vault job-addrs claim-addrs  exit-ch]
   (go-loop [active-job nil]
     (let [timeout-ch (timeout 2000)
           network (vault/get-secret vault :solana-network)]
       (async/alt!
         exit-ch nil
         (timeout 30000) (if active-job
                           ;; if we're running a job: check if it's finished
                           (let [flow (<! (kv/get store active-job))
                                 ;; TODO: here we manually detect a flow failure
                                 ;; and trigger an FX and then restore the
                                 ;; flow. this should be handled by Nostromo
                                 ;; error handlers when implemented there.
                                 flow (if (flow-git-failed? flow)
                                        (flow/handle-fx {:store store :chan flow-ch :vault vault}
                                                        nil
                                                        [:nos.nosana/complete-job]
                                                        flow)
                                        flow)
                                 _ (<! (kv/assoc store active-job flow))]
                             (log :info "Polling Nosana job. Current running job is " (:id flow))
                             (if (flow-finished? flow)
                               (let [job-addr (get-in flow [:results :input/job-addr])
                                     finish-sig
                                     (try
                                       ;; (finish-job-tx! job-addr
                                       ;;                 (get-in flow [:results :result/ipfs])
                                       ;;                 (get-signer-key vault)
                                       ;;                 network)
                                       (catch Exception e
                                         (log :error "Finished job transaction failed. Sleep and retry." (ex-message e))
                                         (<! (timeout 10000))
                                         nil))]
                                 (log :info "Waiting for finish job tx " finish-sig)
                                 (if finish-sig
                                   (do
                                     (<! (sol/await-tx< finish-sig network))
                                     (log :info "Job finished and status refreshed in backend" job-addr)
                                     (recur nil))
                                   (recur active-job)))
                               ;; if flow is not finished
                               (recur active-job)))
                           ;; else: we're not running a job: poll for a new one
                           (do
                             (log :info "Polling for a new Nosana job.")
                             ;; (if-let [flow-id (or (<! (reclaim-nosana-job< store flow-ch vault @claim-addrs network))
                             ;;                      (<! (poll-nosana-job< store flow-ch vault @job-addrs network)))]
                             ;;   (do
                             ;;     (log :info "Started processing of job flow " flow-id)
                             ;;     (recur flow-id))
                             ;;   (do
                             ;;     (log :info "No jobs found. Sleeping.")
                             ;;     (recur nil)))
                             )))))))

(derive :nos/jobs :duct/daemon)

(def ascii-logo "  _ __   ___  ___  __ _ _ __   __ _
 | '_ \\ / _ \\/ __|/ _` | '_ \\ / _` |
 | | | | (_) \\__ \\ (_| | | | | (_| |
 |_| |_|\\___/|___/\\__,_|_| |_|\\__,_|")

;;(nos/print-head "v0.3.19" "4HoZogbrDGwK6UsD1eMgkFKTNDyaqcfb2eodLLtS8NTx" "0.084275" "13,260.00")
(defn print-head [version address network balance stake]
  (logg/infof "
%s

Running Nosana Node %s

  Validator  \u001B[34m%s\u001B[0m
  Network    Solana \u001B[34m%s\u001B[0m
  Balance    \u001B[34m%s\u001B[0m SOL
  Stake      \u001B[34m%s\u001B[0m NOS
  Slashed    \u001B[34m0.00\u001B[0m NOS

Node started. LFG.
"
              ascii-logo
              version
              address
              network
              balance
              stake
              ))

(defn make-config
  "Build the node's config to interact with the Nosana Network."
  [system]
  (let [network      (-> system :nos/vault :solana-network)
        signer       (-> system :nos/vault get-signer-key)
        signer-pub   (.getPublicKey signer)
        programs     (network nos-accounts)
        market-pub   (PublicKey. (-> system :nos/vault :nosana-market))
        market-vault (sol/pda
                      [(.toByteArray market-pub)
                       (.toByteArray (:nos-token programs))]
                      (:job programs))
        stake        (sol/pda
                      [(.getBytes "stake")
                       (.toByteArray (:nos-token programs))
                       (.toByteArray (.getPublicKey signer))]
                      (:stake programs))
        nft          (PublicKey. (-> system :nos/vault :nft))
        nft-ata      (sol/get-ata signer-pub nft)
        nos-ata      (sol/get-ata signer-pub (:nos-token programs))
        dummy        (-> system :nos/vault :dummy-private-key byte-array Account.)]
    {:network      network
     :signer       signer
     :dummy-signer dummy
     :pinata-jwt   (-> system :nos/vault :pinata-jwt)
     :dummy        (.getPublicKey dummy)
     :market       market-pub
     :address      signer-pub
     :programs     programs
     :nos-ata      nos-ata
     :stake-vault  (sol/pda [(.getBytes "vault")
                             (.toByteArray (:nos-token programs))
                             (.toByteArray signer-pub)]
                            (:stake programs))
     :accounts     {"tokenProgram"      (:token sol/addresses)
                    "systemProgram"     (:system sol/addresses)
                    "rent"              (:rent sol/addresses)
                    "accessKey"         (PublicKey. (-> system :nos/vault :nft-collection))
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



(defn build-idl-tx [program ins args {:keys [network accounts]} extra-accounts]
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
        tx   (build-idl-tx :job "list" [(ipfs-hash->job-bytes hash)]
                           conf {"job" (.getPublicKey job)
                                 "run" (.getPublicKey run)})]
    (log :info "Listing job with hash " (-> job .getPublicKey .toString) hash)
    (sol/send-tx tx [(:signer conf) job run] (:network conf))))

(defn enter-market
  "Enter market, assuming there are no jobs in the queue."
  [{:keys [dummy dummy-signer] :as conf}]
  (let [tx (build-idl-tx :job "work" []
                         conf {"run" dummy})]
    (sol/send-tx tx [(:signer conf) dummy-signer] (:network conf))))

(defn finish-job
  "Post results for an owned job."
  [{:keys [network signer] :as conf} job run ipfs-hash]
  (-> (build-idl-tx :job "finish"
                    [(ipfs-hash->job-bytes ipfs-hash)]
                    conf
                    {"job" job
                     "run" run})
      (sol/send-tx [signer] network)))

(defn get-job [{:keys [network programs]} addr]
  (sol/get-idl-account (:job programs) "JobAccount" addr network))

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

(defn work [conf]
  (let [active-jobs (find-my-jobs conf)]

    ))

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
        job-info (download-job-ipfs (:ipfsJob job))]
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

(defmethod ig/init-key :nos/jobs
  [_ {:keys [store flow-ch vault] :as system}]
  (let [network       (:solana-network vault)
        market        (:nosana-market vault)
        conf          (make-config system)
        market-acc    (get-market conf)

        exit-ch       (chan)
        ;; loop-ch       (poll-job-loop store flow-ch vault jobs-addrs reclaim-addrs exit-ch)
        ;; chimes        (chime/periodic-seq (Instant/now) (Duration/ofMinutes 1))
        ]
    (log :info "Node configuration "
         (.toString (.getPublicKey (get-signer-key vault)))
         (:solana-network vault)
         (:nosana-jobs-queue vault))

    (print-head
     ;; TODO: version?
     "v0.3.19"
     (.toString (.getPublicKey (get-signer-key vault)))
     (:solana-network vault)
     "0.084275"
     "13,260.00")

    {;:loop-chan     loop-ch
     ;; put any value to `exit-ch` to cancel the `loop-ch`:
     ;; (async/put! exit-ch true)
     :exit-chan     (chan)
     :poll-delay    5000
     #_:refresh-jobs-chime
     #_ (chime/chime-at chimes
                       (fn [time]
                         (let [new-jobs     (->> (find-jobs-queues-to-poll (:nosana-jobs-queue vault)) (into []))
                               new-reclaims (->> (find-jobs-queues-to-poll (:nosana-reclaim-queue vault)) (into []))]
                           (log :info "Scanning for jobs. Found " (count new-jobs) new-jobs)
                           (log :info "Refreshing reclaims. There are " (count new-reclaims) new-reclaims)
                           (reset! jobs-addrs new-jobs)
                           (reset! reclaim-addrs new-reclaims))))
     }))

(defmethod ig/halt-key! :nos/jobs
  [_ {:keys [loop-chan refresh-jobs-chime exit-chan project-addrs]}]
  (put! exit-chan true)
  ;(.close refresh-jobs-chime)
  )
