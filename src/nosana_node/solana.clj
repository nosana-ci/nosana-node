(ns nosana-node.solana
  (:require [nosana-node.util :as util])
  (:import
   [org.p2p.solanaj.utils ByteUtils]
   [org.p2p.solanaj.rpc RpcClient Cluster]
   [org.bitcoinj.core Utils Base58]
   [org.p2p.solanaj.core Transaction TransactionInstruction PublicKey
    Account Message AccountMeta]))

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
