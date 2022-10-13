(ns nosana-node.solana
  (:require [nosana-node.util :refer [hex->bytes base58] :as util]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [taoensso.timbre :refer [log]]
            [clojure.core.async :as async :refer [<!! <! >!! put! go go-loop >! timeout take! chan]]
            [cheshire.core :as json]
            [clj-http.client :as http]
            [clojure.java.io :as io])
  (:import
   [org.p2p.solanaj.utils ByteUtils]
   [org.p2p.solanaj.rpc RpcClient Cluster]
   [org.bitcoinj.core Utils Base58 Sha256Hash]
   [java.io ByteArrayOutputStream ByteArrayInputStream]
   [java.util Arrays]
   [java.util.zip Inflater InflaterInputStream]
   [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
    Account Message AccountMeta]))

(def rpc {:testnet "https://api.testnet.solana.com"
          :devnet  "https://api.devnet.solana.com"
          :mainnet "https://solana-api.projectserum.com"})

(defn account [] (Account.))

(defn rpc-call
  "Make a solana RPC call.
  This uses clj-http instead of solanaj's client."
  [method params network]
  (->
   (http/post (get rpc network)
              {:body         (json/encode {:jsonrpc "2.0" :id "1" :method method :params params})
               :content-type :json})
   ))

(defn get-balance [addr network]
  (->
   (rpc-call "getBalance" [(.toString addr)] network)
   :body (json/decode true) :result :value))

(defn get-token-balance [addr network]
  (->
   (rpc-call "getTokenAccountBalance" [(.toString addr)] network)
   :body (json/decode true) :result :value :uiAmount))

(defn get-account-data
  "Get the data of a Solana account as ByteArray."
  [addr network]
  (if-let [data (->
                 (rpc-call "getAccountInfo" [(.toString addr) {:encoding "base64"}] network)
                 :body
                 (json/decode true)
                 :result :value :data
                 first)]
    (-> data util/base64->bytes byte-array)
    (throw (ex-info "No account data" {:addr addr}))))

(defn create-pub-key-from-seed
  "Derive a public key from another key, a seed, and a program ID.
  Implementation web3.PublicKey.createWithSeed missing in solanaj"
  [^PublicKey from ^String seed ^PublicKey program-id]
  (doto (ByteArrayOutputStream.)
         (.writeBytes (.toByteArray from))
         (.writeBytes (.getBytes seed))
         (.writeBytes (.toByteArray program-id))))

(defn get-idl-address
  "Get the PublicKey associated with to IDL of a program.
  Anchor has a deterministic way to find the account holding the IDL
  for a specific program."
  [^PublicKey program-id]
  (let [base     (.getAddress (PublicKey/findProgramAddress [] program-id))
        buffer   (create-pub-key-from-seed base "anchor:idl" program-id)
        hash     (Sha256Hash/hash (.toByteArray buffer))]
    (PublicKey. hash)))

(def fetch-idl
  "Fetch the IDL associated with an on-chain program.
  Returns the IDL as a map with keywordized keys."
  (memoize
   (fn [^PublicKey program-id network]
     (let [acc-data  (-> program-id
                         get-idl-address
                         .toString
                         (get-account-data network))
           ;; skip discriminator and authority key
           idl-data  (Arrays/copyOfRange acc-data (+ 4 40) (count acc-data))
           in-stream (InflaterInputStream. (ByteArrayInputStream. idl-data))]
       (json/decode
        (String. (.readAllBytes in-stream) java.nio.charset.StandardCharsets/UTF_8)
        true)))))

(defn anchor-dispatch-id
  "Get the Anchor dispatch for a method.

  Anchor uses an 8 byte dispatch ID for program methods, derived from the method
  name: `Sha256(<namespace>:<method>)[..8]`.

  For user defined methods the namespace is \"global\"."
  [method]
  (->> (str "global:" method) util/sha256 (take 16) (reduce str)))

(defn anchor-account-discriminator
  "Get the Anchor discriminator for an account.

  The first 8 bytes of the account data in an Anchor account match
  this value: `Sha256(account:<name>)[..8]`."
  [account-name]
  (->> (str "account:" account-name) util/sha256 (take 16) (reduce str)))

(defn idl-type->size
  "Get the size in bytes of an IDL data type.
  Input is an IDL type like \"u64\" or `{:array [\"u8\" 32]}`"
  [type idl]
  (cond
    (= type "u64")       8
    (= type "i64")       8
    (= type "u32")       4
    (= type "u8")        1
    (= type "publicKey") 32

    ;; array is fixed length
    (:array type)
    (let [[inner-type length] (:array type)]
      (* length (idl-type->size inner-type idl)))

    ;; vector is dycnamic length so can only calculate with
    ;; `read-type`, where the data is present
    (:vec type)
    (throw (Exception. "Can not read size of dynamic length vector"))

    ;; defined refers to a custom struct defined in the idl
    (:defined type)
    (let [elm-type   (:defined type)
          idl-fields (->> idl :types (filter #(= (:name %) elm-type)) first :type :fields)]
      (->> idl-fields
           (map #(idl-type->size (:type %) idl))
           (reduce +)))

    :else (throw (ex-info "Unkown IDL type " {:type type}))))


(def addresses
  {:token             (PublicKey. "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
   :system            (PublicKey. "11111111111111111111111111111111")
   :rent              (PublicKey. "SysvarRent111111111111111111111111111111111")
   :clock             (PublicKey. "SysvarC1ock11111111111111111111111111111111")
   :metaplex-metadata (PublicKey. "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")})

(def nos-addr (PublicKey. "devr1BGQndEW5k5zfvG5FsLyZv1Ap73vNgAHcQ9sUVP"))
(def nos-jobs (PublicKey. "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM"))
(def nos-stake (PublicKey. "nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE"))
(def ata-addr (PublicKey. "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))

(def nos-collection (PublicKey. "CBLH5YsCPhaQ79zDyzqxEMNMVrE5N7J6h4hrtYNahPLU"))

(defn get-metadata-pda
  "Finds the MetaPlex metadata address for an NFT mint
  See https://docs.metaplex.com/programs/token-metadata/changelog/v1.0"
  [mint-id]
  (.getAddress
   (PublicKey/findProgramAddress [(.getBytes "metadata")
                                  (.toByteArray (:metaplex-metadata addresses))
                                  (.toByteArray mint-id)]
                                 (:metaplex-metadata addresses))))

(defn get-nos-market-pda
  "Find the PDA of a markets vault."
  [market]
  (PublicKey/findProgramAddress [(.toByteArray market)
                                 (.toByteArray nos-addr)]
                                nos-jobs))

(defn pda [seeds program]
  (.getAddress (PublicKey/findProgramAddress seeds program)))

(defn get-nos-stake-pda
  "Find the PDA of a stake for an account."
  [addr]
  (PublicKey/findProgramAddress [(.getBytes "stake")
                                 (.toByteArray nos-addr)
                                 (.toByteArray addr)]
                                nos-stake))

(defn get-ata
  "Find the Associated Token Account for an address and mint."
  [addr mint]
  (.getAddress
   (PublicKey/findProgramAddress [(.toByteArray addr)
                                  (.toByteArray (:token addresses))
                                  (.toByteArray mint)]
                                 ata-addr)))

;; TEMP: account needed for enter instructions
(def enter-accs
  {"authority" (PublicKey. "9cqm92kXLEyiNdU2WrHznkdidEHHB7UCApJrKHvU5TpP")
   "market"    (PublicKey. "CH8NQN6BU7SsRaqcMdbZJsEG7Uaa2jLkfsJqJkQ9He8z")
   "vault"     (PublicKey. "XGGfV7zMhzrQAmxD4uhFUt2ddhfNfnGpYprtz6UuHDB")
   "stake"     (PublicKey. "27xwnefmARrp9GoKQRiEMk3YSXdM5WUTAidir8kGdLTB")
   "nft"       (PublicKey. "BSCogYjj6tAfK5S6wm6oGMda5s72qW3SJvbDvAV5sdQ2")
   "metadata"  (PublicKey. "6pYVk617FEPdgiPzrpNLRrq7L9c66y91AEUMJtLjkbEi")})

(defn read-type
  "Reads a single IDL parameter of `type` from byte array `data`.

  Starts reading at `ofs`. Type is as defined in the IDL, like
  `\"u64\"` or `{:vec \"publicKey\"}`. Returns a tuple with the total
  number of bytes read and the clojure data.

  If `prefix-size?` is false then return only the clojure data."
  ([data ofs type idl] (read-type data ofs type idl true))
  ([data ofs type idl prefix-size?]
   (cond->
     (cond
       (= type "u64")       [8 (ByteUtils/readUint64 data ofs)]
       (= type "i64")       [8 (Utils/readInt64 data ofs)]
       (= type "u32")       [4 (Utils/readUint32 data ofs)]
       (= type "u8")        [1 (get data ofs)]
       (= type "publicKey") [32 (PublicKey/readPubkey data ofs)]

       ;; vectors are dynamic sized
       (:vec type)
       (let [elm-type  (:vec type)
             elm-count (Utils/readUint32 data ofs)
             elm-size  (idl-type->size elm-type idl)
             type-size (+ 4 (* elm-size elm-count))]
         [type-size
          (for [i    (range elm-count)
                :let [idx (+ ofs 4 (* i elm-size))]]
            (read-type data idx elm-type idl false))])

       ;; arrays are static sized
       (:array type)
       (let [[elm-type elm-count] (:array type)
             elm-size             (idl-type->size elm-type idl)
             type-size            (* elm-size elm-count)]
         [type-size
          (for [i    (range elm-count)
                :let [idx (+ ofs (* i elm-size))]]
            (read-type data idx elm-type idl false))])

       ;; defined refers to a type struct in the idl
       (:defined type)
       (let [elm-type   (:defined type)
             idl-fields (->> idl :types (filter #(= (:name %) elm-type)) first :type :fields)]
         (loop [loop-size           0
                [field & remaining] idl-fields
                results             {}]
           (if field
             (let [[size value] (read-type data (+ ofs loop-size) (:type field) idl)]
               (recur (+ loop-size size) remaining (assoc results (:name field) value)))
             [loop-size results])))

       :else (throw (ex-info "Unkown IDL type " {:type type})))
     ;; if not prefix-size? skip size
     (not prefix-size?) second)))

(defn write-type
  "Writes a single IDL parameter of `type` to byte array `data`."
  [data ofs type value idl]
  (cond
    (= type "u8") (aset-byte data ofs (unchecked-byte value))
    (= type "u64")
    (let [bos (ByteArrayOutputStream.)]
      (ByteUtils/uint64ToByteStreamLE (BigInteger. value) bos)
      (System/arraycopy (.toByteArray bos) 0 data ofs 8))

    ;; arrays are static sized
    (:array type)
    (let [[elm-type elm-count] (:array type)
          elm-size             (idl-type->size elm-type idl)]
      (doseq [i (range elm-count)
              :let [idx (+ ofs (* i elm-size))]]
        (write-type data idx elm-type (nth value i) idl)))

    :else (throw (ex-info "Unkown IDL type " {:type type}))))

(defn build-idl-tx
  "Build a transaction using the IDL of a program.
  The IDL is fetched from the blockchain using the Anchor standard."
  [program-id ins args accounts network]
  (let [idl           (fetch-idl program-id network)
        discriminator (hex->bytes (anchor-dispatch-id ins))
        ins           (->> idl :instructions (filter #(= (:name %) ins)) first)
        ins-keys      (java.util.ArrayList.)
        args-size     (reduce #(+ %1 (idl-type->size (:type %2) idl)) 0 (:args ins))
        ins-data      (byte-array (+ 8 args-size))]

    ;; build up the instructions ArrayList
    (doseq [{:keys [name isMut isSigner]} (:accounts ins)]
      (when (not (contains? accounts name))
        (throw (ex-info "Missing required account for instruction" {:missing name})))
      (.add ins-keys (AccountMeta. (get accounts name) isSigner isMut)))

    ;; in anchor the instruction data always starts with 8 bytes id
    (System/arraycopy discriminator 0 ins-data 0 8)
    (doseq [[arg-value {:keys [name type]}] (zipmap args (:args ins))]
      (write-type ins-data 8 type arg-value idl))

    (let [txi (TransactionInstruction. program-id ins-keys ins-data)
        tx  (doto (Transaction.)
              (.addInstruction txi))]
      tx)))

;; (let [data (byte-array 30)] (sol/write-type data  0  {:array ["u8" 30]}  (range 30) {}) data)
;; (def tx (nos/build-idl-tx :job "work" [] conf {"job" (.getPublicKey (:dummy-signer conf))}))
;; (def tx (nos/build-idl-tx :job "list" [(range 32)] conf {"job" (.getPublicKey (:dummy-signer conf))}))
;; (sol/send-tx tx [(:signer conf) (:dummy-signer conf)] :devnet)

;; (def job (Account.))
;; (def tx (nos/build-idl-tx :job "list" [(range 32)] conf {"job" (.getPublicKey job)}))
;; (sol/send-tx tx [(:signer conf) job)] :devnet)

(defn get-idl-field-offset [program-id account-type field-name network]
  (let [idl (fetch-idl program-id network)
        fields
        (->> idl :accounts (filter #(= (:name %) account-type)) first :type :fields)]
    (loop [[{:keys [name type]} & remaining] fields
           ofs             8]
      (if (= name field-name)
        ofs
        (recur remaining
               (+ ofs (idl-type->size type idl)))))))

(defn decode-idl-account
  "Decode an accounts byte array to a map using its IDL."
  [acc-data program-id account-type network]
  (let [idl (fetch-idl program-id network)
        {:keys [type fields]}
        (->> idl :accounts (filter #(= (:name %) account-type)) first :type)]
    (loop [ofs                 8
           [field & remaining] fields
           data                {}]
      (if field
        (let [[size value] (read-type acc-data ofs (:type field) idl)]
          (recur (+ ofs size)
                 remaining
                 (assoc data (keyword (:name field)) value)))
        data))))

(defn get-idl-account
  "Fetches and decodes a program account using its IDL."
  [program-id account-type addr network]
  (let [idl      (fetch-idl program-id network)
        acc-data (get-account-data addr network)]
    (decode-idl-account acc-data program-id account-type network)))

(defn get-program-accounts
  "RPC call to `getProgramAccounts`"
  [network account filters]
  (->
   (rpc-call "getProgramAccounts"
             [(.toString account)
              {:encoding "jsonParsed"
               :filters filters}]
             network)
   :body
   (json/decode true)
   :result))

(defn get-idl-program-accounts
  "Gets and decode a program account of a specific IDL with filters.
  Filters can be specified as a map of attribute to base58 encoded
  value."
  [network account type filters]
  (let [disc-filter {:memcmp {:offset 0
                               :bytes (-> type anchor-account-discriminator
                                          hex->bytes base58)}}
        accounts  (get-program-accounts
                   network account
                   (-> (map
                        (fn [[name bytes]]
                          {:memcmp {:offset (get-idl-field-offset account type name network)
                                    :bytes  bytes}})
                        filters)
                       (conj disc-filter)))
        decoded   (->> accounts
                       (map #(-> % :account :data first util/base64->bytes))
                       (map #(decode-idl-account % account type network)))
        addresses (map :pubkey accounts)]
    (zipmap addresses decoded)))

(defn send-tx
  "Sign and send a transaction using solanaj rpc.
  `signers` should be clojure seq of PublicKeys"
  [tx signers network]
  (let [client (RpcClient. (get rpc network))
        api (.getApi client)
        sig (.sendTransaction api tx (java.util.ArrayList. signers))]
    sig))

(defn get-tx
  "Get transaction `sig` as keywordized map"
  [sig network]
  (-> (rpc-call "getTransaction" [sig "json"] network)
      :body
      (json/decode true)
      :result))

(defn await-tx<
  "Returns a channel that emits transaction `sig` when it finalizes."
  ([sig network] (await-tx< sig 1000 30 network))
  ([sig timeout-ms max-tries network]
   (log :trace "Waiting for Solana tx " sig)
   (go-loop [tries 0]
     (log :trace "Waiting for tx " tries)
     (when (< tries max-tries)
       (if-let [tx (get-tx sig network)]
         tx
         (do (<! (timeout timeout-ms))
             (recur (inc tries))))))))

;;=================
;; EXAMPLES
;;=================

;; (sol/fetch-idl "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM" :mainnet)


;; (def k (PublicKey. "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM"))

#_(def accs {"authority" k
             "market"    k
             "vault"     k
             "stake"     k
             "nft"       k
             "metadata"  k})

;; (sol/idl-tx idl "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM" "enter" accs)

;; (def tx (nos/build-idl-tx :job "work" conf {"job" (.getPublicKey (:dummy-signer conf))}))
;; (sol/send-tx tx [(:signer conf) (:dummy-signer conf)] :devnet)
