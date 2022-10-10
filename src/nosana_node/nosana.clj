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
            [nosana-node.solana :as sol])
  (:import java.util.Base64
           java.security.MessageDigest
           [java.time Instant Duration]
           [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
            Account Message AccountMeta]
           [org.p2p.solanaj.utils ByteUtils]
           [org.p2p.solanaj.rpc RpcClient Cluster]
           [org.bitcoinj.core Utils Base58]))

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

(defn addr [addr network] (get-in nos-config [network addr]))

(def system-program (PublicKey. "11111111111111111111111111111111"))
(def rent-program (PublicKey. "SysvarRent111111111111111111111111111111111"))
(def clock-addr (PublicKey. "SysvarC1ock11111111111111111111111111111111"))

(defn vault-derived-addr [network]
  (PublicKey/findProgramAddress [(.toByteArray (-> nos-config network :nos-token))]
                                (-> nos-config network :job)))

(defn vault-ata-addr [network] (.getAddress (vault-derived-addr network)))

(def job-acc (Account.))

(def instruction->idx
  {:init-project "284e9c7a3655cc2e"
   :init-vault "4d4f559621d9346a"
   :reclaim-job "b1fbd94ecf422e82"})

(defn bytes-to-hex-str
  "Convert a seq of bytes into a hex encoded string."
  [bytes]
  (apply str (for [b bytes] (format "%02x" b))))

(defn make-job-ipfs-hash
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

;; (defn sol-create-job-instruction []
;;   ;; TODO: figure out the anchor instruction index hash
;;   (let [job-key (.getPublicKey job-acc)
;;         jobs-key (PublicKey. "2HdVyw5BXziGPTS8EUpEcMbBfbkA6dXPzt9tYjugSqUu")
;;         keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. jobs-key false true))           ; jobs
;;                (.add (AccountMeta. job-key true true))             ; job
;;                (.add (AccountMeta. nos-token-addr false false))    ; nos
;;                (.add (AccountMeta. vault-ata-addr false true))     ; vault
;;                (.add (AccountMeta. signer-ata-addr false true))    ; nosFrom
;;                (.add (AccountMeta. signer-addr true false))        ; project
;;                (.add (AccountMeta. token-program-id false false))  ; token
;;                (.add (AccountMeta. system-addr false false))       ; system

;;                )
;;         data (byte-array (repeat (+ 4 1 8) (byte 0)))]
;;     (prn (bytes-to-hex-str data))
;;     (Utils/uint32ToByteArrayLE 2783 data 0)
;;     (aset-byte data 4 (unchecked-byte 254))
;;     ;; (prn (.getNonce vault-derived-addr))
;;     (Utils/int64ToByteArrayLE 10 data 5)
;;     (prn (bytes-to-hex-str data))
;;     (let [txi (TransactionInstruction. job-program-addr keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

(defn sol-finish-job-tx [job-addr ipfs-hash signer-addr network]
  (let [job-key (PublicKey. job-addr)
        get-addr #(-> nos-config network %)
        keys (doto (java.util.ArrayList.)
               (.add (AccountMeta. job-key false true))            ; job
               (.add (AccountMeta. (vault-ata-addr network) false true))     ; vault-ata
               (.add (AccountMeta. (get-addr :signer-ata) false true))    ; ataTo
               (.add (AccountMeta. signer-addr true false))        ; authority
               (.add (AccountMeta. token-program-id false false))  ; token
               (.add (AccountMeta. clock-addr false false))        ; clock
               )
        data (byte-array (repeat (+ 8 1 32) (byte 0)))
        ins-idx (byte-array (javax.xml.bind.DatatypeConverter/parseHexBinary "73d976b04fcbc8c2"))]
    (System/arraycopy ins-idx 0 data 0 8)
    (aset-byte data 8 (unchecked-byte (.getNonce (vault-derived-addr network))))
    (System/arraycopy (ipfs-hash->job-bytes ipfs-hash) 0 data 9 32)
    (let [txi (TransactionInstruction. (get-addr :job) keys data)
          tx (doto (Transaction.)
               (.addInstruction txi)
               )]
      tx)))

;; (defn sol-init-project-instruction []
;;   (let [
;;         job-key (.getPublicKey job-acc)
;;         keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. (.getAddress jobs-derived-addr) false true))           ; jobs
;;                (.add (AccountMeta. signer-addr true true))      ; project
;;                (.add (AccountMeta. system-addr false false))     ; system
;;                )
;;         data (byte-array (repeat (+ 8) (byte 0)))
;;         ins-idx (byte-array (javax.xml.bind.DatatypeConverter/parseHexBinary "284e9c7a3655cc2e"))]
;;     (System/arraycopy ins-idx 0 data 0 8)
;;     (let [txi (TransactionInstruction. job-program-addr keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

(defn sol-claim-job-instruction [jobs-addr job-addr signer-addr network]
  (let [get-addr #(-> nos-config network %)
        keys (doto (java.util.ArrayList.)
               (.add (AccountMeta. (PublicKey. jobs-addr) false true))         ; jobs
               (.add (AccountMeta. (PublicKey. job-addr) false true))         ; job
               (.add (AccountMeta. signer-addr true false))     ; authority
               (.add (AccountMeta. clock-addr false false))     ; clock
               )
        data (byte-array (repeat (+ 8) (byte 0)))
        ins-idx (byte-array (hex->bytes "09a005e7747bc60e"))]
    (System/arraycopy ins-idx 0 data 0 8)
    (let [txi (TransactionInstruction. (get-addr :job) keys data)
          tx (doto (Transaction.)
               (.addInstruction txi)
               )]
      tx)))

(defn sol-reclaim-job-instruction [job-addr signer-addr network]
  (let [get-addr #(-> nos-config network %)
        keys (doto (java.util.ArrayList.)
               (.add (AccountMeta. (PublicKey. job-addr) false true))         ; job
               (.add (AccountMeta. signer-addr true false))     ; authority
               (.add (AccountMeta. clock-addr false false))     ; clock
               )
        data (byte-array (repeat (+ 8) (byte 0)))
        ins-idx (byte-array (hex->bytes (:reclaim-job instruction->idx)))]
    (System/arraycopy ins-idx 0 data 0 8)
    (let [txi (TransactionInstruction. (get-addr :job) keys data)
          tx (doto (Transaction.)
               (.addInstruction txi)
               )]
      tx)))

;; (defn sol-init-vault-instruction []
;;   (let [keys (doto (java.util.ArrayList.)
;;                (.add (AccountMeta. signer-addr true false))        ; project
;;                (.add (AccountMeta. nos-token-addr false false))    ; nos
;;                (.add (AccountMeta. system-addr false false))       ; system
;;                (.add (AccountMeta. vault-ata-addr false true))     ; vault
;;                (.add (AccountMeta. token-program-id false false))  ; token
;;                (.add (AccountMeta. rent-addr false false))         ; rent
;;                )
;;         data (byte-array (repeat (+ 8 1) (byte 0)))
;;         ins-idx (byte-array (javax.xml.bind.DatatypeConverter/parseHexBinary "4d4f559621d9346a"))]
;;     (prn (bytes-to-hex-str (.toByteArray signer-addr)))
;;     (prn (bytes-to-hex-str (.toByteArray nos-token-addr)))
;;     (prn (bytes-to-hex-str (.toByteArray vault-ata-addr)))
;;     (prn (bytes-to-hex-str (.toByteArray system-addr)))
;;     (prn (bytes-to-hex-str (.toByteArray token-program-id)))
;;     (prn (bytes-to-hex-str (.toByteArray rent-addr)))

;;     (System/arraycopy ins-idx 0 data 0 8)
;;     (javax.xml.bind.DatatypeConverter/parseHexBinary "aaff")
;;     (aset-byte data 8 (unchecked-byte 255))
;;     (let [txi (TransactionInstruction. job-program-addr keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))

;; Example how to print a raw transaction
(defn print-raw-tx! [signer]
  ;; (prn "nonce: "   (.getNonce vault-derived-addr ))

  (let [;;client (RpcClient. "http://localhost:8899")
        client (RpcClient. (:testnet sol-rpc))
        api (.getApi client)
        ;; tx (sol-create-job-instruction)
        block-hash (.getRecentBlockhash api)
        tx (doto (sol-reclaim-job-instruction
                  "22111111111111111111111111111122"
                  "33111111111111111111111111111133"
                  (.getPublicKey signer) :mainnet)
             (.setRecentBlockHash block-hash)
             (.sign [signer])
             )
        _ (prn "bh: " block-hash)
        _ (prn(bytes-to-hex-str (Base58/decode block-hash)))
        _ (prn (bytes-to-hex-str (.serialize tx)))
        ;; sig (.sendTransaction api tx [signer-acc])
        ]
    ;;sig
    nil
    ))

(defn claim-job-tx! [jobs-addr job-addr signer network]
  (let [client (RpcClient. (get sol-rpc network))
        api (.getApi client)
        block-hash (.getRecentBlockhash api)
        tx (doto (sol-claim-job-instruction jobs-addr job-addr (.getPublicKey signer) network))
        sig (.sendTransaction api tx [signer])]
    sig))

(defn reclaim-job-tx! [job-addr signer network]
  (let [client (RpcClient. (get sol-rpc network))
        api (.getApi client)
        block-hash (.getRecentBlockhash api)
        tx (doto (sol-reclaim-job-instruction job-addr (.getPublicKey signer) network))
        sig (.sendTransaction api tx [signer])]
    sig))

(defn finish-job-tx! [job-addr result-ipfs signer network]
  (let [client (RpcClient. (get sol-rpc network))
        api (.getApi client)
        block-hash (.getRecentBlockhash api)
        tx (doto (sol-finish-job-tx job-addr result-ipfs (.getPublicKey signer) network))
        sig (.sendTransaction api tx [signer])]
    sig))

(defn rpc-call [method params network]
  (http/post (get sol-rpc network) {:body (json/encode {:jsonrpc "2.0" :id "1" :method method :params params}) :content-type :json}))

(defn get-account-data
  "Get the data of a Solana account as byte array"
  [addr network]
  (if-let [data (->
                 (rpc-call "getAccountInfo" [addr {:encoding "base64"}] network)
                 :body
                 (json/decode true)
                 :result :value :data
                 first)]
    (-> data base64->bytes byte-array)
    (throw (ex-info "No account data" {:addr addr}))))

(defn get-solana-tx
  "Get a Solana transaction as map"
  [sig network]
  (-> (rpc-call "getTransaction" [sig "json"] network)
      :body
      (json/decode true)
      :result))

(defn get-solana-tx<
  "Returns a channel that emits transaction `sig` when it appears on the blockchain"
  ([sig network] (get-solana-tx< sig 1000 30 network))
  ([sig timeout-ms max-tries network]
   (log :trace "Waiting for Solana tx " sig)
   (go-loop [tries 0]
     (log :trace "Waiting for tx " tries)
     (when (< tries max-tries)
       (if-let [tx (get-solana-tx sig network)]
         tx
         (do (<! (timeout timeout-ms))
             (recur (inc tries))))))))

(defn get-jobs [jobs-addr network]
  (let [data (get-account-data jobs-addr network)
        _ (ByteUtils/readUint64 data 0)        ; ??
        owner  (.toString (PublicKey/readPubkey data 8))
        num-jobs (Utils/readUint32 data (+ 8 32))
        jobs (for [i (range num-jobs)]
               (.toString (PublicKey/readPubkey data (+ 8 32 4 (* i 32)))))]
    {:addr jobs-addr
     :owner owner
     :num-jobs num-jobs
     :jobs jobs}))

(defn get-job [job-addr network]
  (let [data (get-account-data job-addr network)
        _ (ByteUtils/readUint64 data 0)                 ; ??
        node (.toString (PublicKey/readPubkey data 8))  ; claimed by
        status (get data (+ 8 32))                  ; gets 1 when it's claimed, 2 when it's finished
        start-time (Utils/readUint32 data (+ 8 32 1))     ; timestamp
        _ (ByteUtils/readUint64 data (+ 8 32 1 4))          ; ??
        _ (Utils/readUint32 data (+ 8 32 1 4 8))        ; ??

        job-ipfs (-> (PublicKey/readPubkey data (+ 8 32 1 4 8 4))
                     .toByteArray make-job-ipfs-hash)

        result-ipfs (-> (PublicKey/readPubkey data (+ 8 32 1 4 8 4 32))
                        .toByteArray make-job-ipfs-hash)]
    {:addr job-addr
     :node node ;(if (= status 0) nil node)
     :status status
     :job-ipfs job-ipfs
     :start-time start-time
     :result-ipfs (if (= status 2) result-ipfs nil)}))

(defn refresh-backend-job-status
  "Fetch a job status from the backend to refresh it from IPFS"
  [endpoint job-address]
  (http/get (str endpoint job-address)))

(defn download-job [ipfs-hash]
  (log :trace "Downloading IPFS file " ipfs-hash)
  (let [job-url (str ipfs-base-url ipfs-hash)
        job-json (http/get job-url {:accept "json"})
        job (json/decode (:body job-json) true)]
    (update job :pipeline yaml/parse-string)))

(defn sha256 [string]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") (.getBytes string "UTF-8"))]
    (apply str (map (partial format "%02x") digest))))

(defn hash-repo-url
  "Creates a short hash for a repo url"
  [name]
  (->> name sha256 (take 20) (reduce str)))

(defn make-job-flow [job job-addr]
  (let [new-flow (-> base-flow
                     (assoc-in [:results :input/repo] (:url job))
                     (assoc-in [:results :input/path] (str "/tmp/repos/" (hash-repo-url (:url job))))
                     (assoc-in [:results :input/commit-sha] (:commit job))
                     (assoc-in [:results :input/job-addr] job-addr)
                     (assoc-in [:results :input/commands] (:commands job))
                     (update :ops concat (make-cli-ops (-> job :pipeline :commands) {:uri "http://localhost:8080"} (-> job :pipeline :image))))
        last-op-id (-> new-flow :ops last :id)
        wrap-up-op {:op :fx :id :wrap-up :args [[:nos.nosana/complete-job]] :deps [last-op-id]}]
    (->
     new-flow
     (update :ops concat [wrap-up-op])
     (update :ops #(into [] %))
     flow/build)))

(defn make-job-flow-ipfs [job-ipfs job-addr]
  (let [job (download-job job-ipfs)]
    (make-job-flow job job-addr)))


(defn pick-job
  "Picks a single job from a sequence of jobs queues

  `job-addrs` is a sequence of Nosana jobs queues. The queues and their jobs are
  fetched depth-first until a job is found with status unclaimed."
  [job-addrs network]
  (loop [remaining-queues (shuffle job-addrs)]
    (log :info "... Picking jobs " remaining-queues)
    (when (not-empty remaining-queues)
      (if-let [jobs (try
                      (-> remaining-queues first (get-jobs network))
                      (catch Exception e []))]
        (do
          (log :info "... Fetched jobs results is " jobs)
          (if (empty? (:jobs jobs))
            (recur (rest remaining-queues))
            (loop [job-addr (first (:jobs jobs))]
              (log :info "... Getting job " job-addr)
              (let [job (get-job job-addr network)]
                (log :info "... Resulted job info is " job)
                (if (or (= (:status job) 0))
                  [(:addr jobs) job]
                  (recur (rest (:jobs jobs))))))))))))

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
    (when-let [[job-flow claim-sig]
               (<! (async/thread
                     (when-let [[jobs-addr job] (pick-job jobs-addrs network)]
                       (log :info "Trying job " (:addr job) " CID " (:job-ipfs job))
                       (let [job-flow (make-job-flow-ipfs (:job-ipfs job) (:addr job))
                             _ (log :info ".. Made job flow")
                             claim-sig (try
                                         (claim-job-tx! jobs-addr (:addr job) (get-signer-key vault) network)
                                         (catch Exception e
                                           (log :error "Claim job transaction failed." (ex-message e))
                                           nil))]
                         [job-flow claim-sig]))))]
      (when claim-sig
        (when-let [tx (<! (get-solana-tx< claim-sig 2000 30 network))]
          (if (not (solana-tx-failed? tx))
            (do
              (log :info "Job claimed. Starting flow " (:id job-flow))
              (<! (flow/save-flow job-flow store))
              (>! flow-ch [:trigger (:id job-flow)])
              (:id job-flow))
            (log :info "Job already claimed by someone else.")))))))

(defn reclaim-nosana-job<
  "Pick, reclaim and exeucte one job from `claim-addrs`"
  [store flow-ch vault claim-addrs network]
  (go
    (when (not (empty? claim-addrs))
      (when-let [[job-flow claim-sig job-addr]
                 (<! (async/thread
                       (when-let [job (get-job (rand-nth claim-addrs) network)]
                         (log :info "Trying job " (:addr job) " CID " (:job-ipfs job))
                         (let [job-flow (make-job-flow-ipfs (:job-ipfs job) (:addr job))
                               _ (log :info ".. Made job flow")
                               claim-sig (try
                                           (reclaim-job-tx! (:addr job) (get-signer-key vault) network)
                                           (catch Exception e
                                             (log :error "Reclaim job transaction failed." (ex-message e))
                                             nil))]
                           [job-flow claim-sig (:addr job)]))))]
        (when claim-sig
          (when-let [tx (<! (get-solana-tx< claim-sig 2000 30 network))]
            (if (not (solana-tx-failed? tx))
              (do
                (log :info "Job reclaimed" job-addr)
                (refresh-backend-job-status (:nosana-job-status-refresh-url vault) job-addr)
                (log :info "Job status refreshed in backend.")
                (log :info "Starting flow" (:id job-flow))
                (<! (flow/save-flow job-flow store))
                (>! flow-ch [:trigger (:id job-flow)])
                (:id job-flow))
              (log :info "Job already reclaimed by someone else."))))))))

(derive :nos.nosana/complete-job ::flow/fx)

(defn json-to-ipfs
  "Converts a map to a JSON string and pins it using Pinata"
  [obj jwt]
  (->
   (http/post (str pinata-api-url "/pinning/pinJSONToIPFS")
              {:headers {:Authorization (str "Bearer " jwt)}
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
        ipfs (json-to-ipfs job-result (:pinata-jwt vault))]
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

(defn poll-job-loop
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
                                       (finish-job-tx! job-addr
                                                       (get-in flow [:results :result/ipfs])
                                                       (get-signer-key vault)
                                                       network)
                                       (catch Exception e
                                         (log :error "Finished job transaction failed. Sleep and retry." (ex-message e))
                                         (<! (timeout 10000))
                                         nil))]
                                 (log :info "Waiting for finish job tx " finish-sig)
                                 (if finish-sig
                                   (do
                                     (<! (get-solana-tx< finish-sig network))
                                     (refresh-backend-job-status
                                      (:nosana-job-status-refresh-url vault) job-addr)
                                     (log :info "Job finished and status refreshed in backend" job-addr)
                                     (recur nil))
                                   (recur active-job)))
                               ;; if flow is not finished
                               (recur active-job)))
                           ;; else: we're not running a job: poll for a new one
                           (do
                             (log :info "Polling for a new Nosana job.")
                             (if-let [flow-id (or (<! (reclaim-nosana-job< store flow-ch vault @claim-addrs network))
                                                  (<! (poll-nosana-job< store flow-ch vault @job-addrs network)))]
                               (do
                                 (log :info "Started processing of job flow " flow-id)
                                 (recur flow-id))
                               (do
                                 (log :info "No jobs found. Sleeping.")
                                 (recur nil))))))))))

(derive :nos.trigger/nosana-jobs :duct/daemon)

(defn find-jobs-queues-to-poll
  "Fetch job queues to poll from the backend"
  [endpoint]
  (try
    (-> (http/get endpoint) :body json/decode)
    (catch Exception e
      (log :error "Find jobs queue HTTP request failed" endpoint (ex-message e))
      [])))

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
        nft-ata      (sol/get-ata
                      signer-pub
                      (PublicKey. (-> system :nos/vault :nft)))
        nos-ata      (sol/get-ata signer-pub (:nos-token programs))]
    {:network      network
     :signer       signer
     :dummy-signer (-> system :nos/vault :dummy-private-key byte-array Account.)
     :address      signer-pub
     :programs     programs
     :nos-ata      nos-ata
     :accounts     {"tokenProgram"  (:token sol/addresses)
                    "systemProgram" (:system sol/addresses)
                    "rent"          (:rent sol/addresses)
                    "accessKey"     (PublicKey. (-> system :nos/vault :nft-collection))
                    "authority"     signer-pub
                    "market"        market-pub
                    "mint"          (:nos-token programs)
                    "vault"         market-vault
                    "stake"         stake
                    "nft"           nft-ata}}))

(defmethod ig/init-key :nos.trigger/nosana-jobs
  [_ {:keys [store flow-ch vault] :as system}]
  (let [network       (:solana-network vault)
        market        (:nosana-market vault)
        market-acc    (sol/get-idl-account (-> config network :job) "MarketAccount" market network)
        ;; put any value to `exit-ch` to cancel the `loop-ch`:
        ;; (async/put! exit-ch true)
        exit-ch       (chan)
        ;; loop-ch       (poll-job-loop store flow-ch vault jobs-addrs reclaim-addrs exit-ch)
        ;; chimes        (chime/periodic-seq (Instant/now) (Duration/ofMinutes 1))
        ]
    (log :info "Node configuration "
         (.toString (.getPublicKey (get-signer-key vault)))
         (:solana-network vault)
         (:nosana-jobs-queue vault))

    (print-head
     "v0.3.19"
     (.toString (.getPublicKey (get-signer-key vault)))
     (:solana-network vault)
     "0.084275"
     "13,260.00")

    {;:loop-chan     loop-ch
                                        ;:exit-chan     exit-ch
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

(defmethod ig/halt-key! :nos.trigger/nosana-jobs
  [_ {:keys [loop-chan refresh-jobs-chime exit-chan project-addrs]}]
  ;(put! exit-chan true)
  ;(.close refresh-jobs-chime)
  )

;; to quick run from repl:
;;(nos/poll-job-loop (:nos/store system) (:nos/flow-chan system) ["Gcpx9EZSKANBU9nChmkajeaNfrbxWqS2Ytsg3UjnkKmq"])

;;(nos/claim-job-tx! "2xBdvni5b6Nq5dN4trmGW1a3vqJFhxttAR4FXT453WQu" "45dphM6TKD7Yc8GR5hdYUZRP6rS69ruP7dw1uVCCCQmU" (nos/get-signer-key (:nos/vault system) ) :devnet)
;;(nos/make-job-flow "Qmd89t9mWiixJjJgGSKK2wEkNmK7pLmXMJQpArvLYB2gHM" "45dphM6TKD7Yc8GR5hdYUZRP6rS69ruP7dw1uVCCCQmU")
;;(nos/make-cli-ops cmds {:uri "http://localhost:8080"} "alpine")
;;(nos/download-job "Qmd89t9mWiixJjJgGSKK2wEkNmK7pLmXMJQpArvLYB2gHM")
