(ns nosana-node.util
  (:import java.security.MessageDigest
           java.util.Base64
           [org.bitcoinj.core Utils Base58]))

(defn sha256
  "Convert a string to sha256 checksum as a hex string"
  [string]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") (.getBytes string "ASCII"))]
    (apply str (map (partial format "%02x") digest))))

(defn bytes->base64 [bytes] (.encodeToString (Base64/getEncoder) bytes))
(defn str->base64 [string] (.encodeToString (Base64/getEncoder) (.getBytes string)))
(defn base64->bytes [base64] (.decode (Base64/getDecoder) base64))

(defn hex->bytes [string]
  (javax.xml.bind.DatatypeConverter/parseHexBinary string))

(defn bytes->hex [arr]
  (javax.xml.bind.DatatypeConverter/printHexBinary arr))

(defn base58 [bytes] (Base58/encode bytes))

(defn bytes->ipfs-hash
  "Convert the ipfs bytes from a solana job to a CID

  It prepends the 0x1220 to make it 34 bytes and Base58 encodes it. This result
  is IPFS addressable."
  [bytes]
  (->>  bytes bytes->hex (str "1220") hex->bytes Base58/encode ))

(defn ipfs-hash->bytes
  "Convert IPFS hash to a jobs byte array

  It Base58 decodes the hash and drops the first 2 bytes as they are static for
  our IPFS hashses (0x1220, the 0x12 means Sha256 and 0x20 means 256 bits)"
  [hash]
  (->> hash Base58/decode (drop 2) byte-array))
