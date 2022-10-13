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
