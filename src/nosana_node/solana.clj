(ns nosana-node.solana
  (:require [nosana-node.util :as util]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [cheshire.core :as json]
            [clj-http.client :as http]
            [clojure.java.io :as io])
  (:import
   [org.p2p.solanaj.utils ByteUtils]
   [org.p2p.solanaj.rpc RpcClient Cluster]
   [org.bitcoinj.core Utils Base58 Sha256Hash]
   [java.io ByteArrayOutputStream ByteArrayInputStream]
   [java.util Arrays]
   java.util.zip.Inflater    java.util.zip.InflaterOutputStream java.util.zip.InflaterInputStream
   [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
    Account Message AccountMeta]))

(def sol-rpc {:testnet "https://api.testnet.solana.com"
              :devnet "https://api.devnet.solana.com"
              :mainnet "https://solana-api.projectserum.com"})

(defn rpc-call
  "Make a solana RPC call.
  This uses clj-http instead of solanaj's client."
  [method params network]
  (http/post (get sol-rpc network)
             {:body         (json/encode {:jsonrpc "2.0" :id "1" :method method :params params})
              :content-type :json}))

(defn get-account-data
  "Get the data of a Solana account as ByteArray."
  [addr network]
  (if-let [data (->
                 (rpc-call "getAccountInfo" [addr {:encoding "base64"}] network)
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
  [program-id]
  "Get the PublicKey associated with to IDL of a program.
  Anchor has a deterministic way to find the account holding the IDL
  for a specific program. This functions returns the decoded string of
  it."
  (let [base     (.getAddress (PublicKey/findProgramAddress [] (PublicKey. program-id)))
        buffer   (create-pub-key-from-seed base "anchor:idl" (PublicKey. program-id))
        hash     (Sha256Hash/hash (.toByteArray buffer))]
    (PublicKey. hash)))

(defn fetch-idl
  "Fetch the IDL associated with an on-chain program.
  Returns the IDL as a map with keywordized keys."
  [program-id network]
  (let [acc-data  (-> program-id
                           get-idl-address
                           .toString
                           (get-account-data network))
        ;; skip discriminator and authority key
        idl-data  (Arrays/copyOfRange acc-data (+ 4 40) (count acc-data))
        in-stream (InflaterInputStream. (ByteArrayInputStream. idl-data))]
    (json/decode
     (String. (.readAllBytes in-stream) java.nio.charset.StandardCharsets/UTF_8)
     true)))

(defn anchor-dispatch-id
  "Get the Anchor dispatch for a method

  Anchor uses an 8 byte dispatch ID for program methods, dervied from the method
  name: Sha256(<namespace>:<method>)[..8]

  For user defined methods the namespace is global."
  [method]
  (->> method (str "global:") util/sha256 (take 16) (reduce str)))

(defn make-tx-account-list
  "Create an account list for a Solana transaction
  "
  [accounts]
  (reduce
   #()
   accounts
   (java.util.ArrayList)))

(defn make-tx [program method accounts args]
  (let [txi (TransactionInstruction. program accounts args)
        tx (doto (Transaction.) (.addInstruction txi))]
    txi))

(defn idl-type->size
  "Get the size in bytes of an IDL data type.
  Input is an IDL type like \"u64\" or `{:array [\"u8\" 32]}`"
  [type]
  (cond
    (= type "u64")       8
    (= type "i64")       8
    (= type "u32")       4
    (= type "u8")        1
    (= type "publicKey") 40
    (:array type)
    (let [[inner-type length] (:array type)]
      (* length (idl-type->size inner-type)))
    :else (throw (ex-info "Unkown IDL type " {:type type}))))

(defn idl-tx
  "Build a transaction using the IDL of a program."
  [idl program-id ins accounts]
  (let [discriminator (util/hex->bytes (anchor-dispatch-id ins))
        ins           (->> idl :instructions (filter #(= (:name %) ins)) first)
        ins-keys      (java.util.ArrayList.)
        args-size     (reduce #(+ %1  (idl-type->size (:type %2))) 0 (:args ins))
        ins-data      (byte-array (+ 8 args-size))]
    (doseq [{:keys [name isMut isSigner]} (:accounts ins)]
      (when (not (contains? accounts name))
        (throw (ex-message "Missing required account for instruction")))
      (.add ins-keys (AccountMeta. (get accounts name) isSigner isMut)))
    (System/arraycopy discriminator 0 ins-data 0 8)
    (let [txi (TransactionInstruction. program-id ins-keys ins-data)
          tx (doto (Transaction.)
               (.addInstruction txi))]
      tx)))

;;=================
;; EXAMPLES
;;=================

;; (sol/fetch-idl "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM" :mainnet)


;; (def k (PublicKey. "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM"))

;; (def accs {"authority" k
;;            "market"    k
;;            "vault"     k
;;            "stake"     k
;;            "nft"       k
;;            "metadata"  k})

;; (sol/idl-tx idl "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM" "enter" accs)

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
;;     (System/arraycopy ins-idx 0 data 0 8)
;;     (aset-byte data 8 (unchecked-byte (.getNonce (vault-derived-addr network))))
;;     (System/arraycopy (ipfs-hash->job-bytes ipfs-hash) 0 data 9 32)
;;     (let [txi (TransactionInstruction. (get-addr :job) keys data)
;;           tx (doto (Transaction.)
;;                (.addInstruction txi)
;;                )]
;;       tx)))
