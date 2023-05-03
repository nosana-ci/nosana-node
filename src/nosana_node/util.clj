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

(defn hex->bytes
  "Convert hex string to byte sequence"
  [string]
  (letfn [(unhexify-2 [c1 c2]
            (unchecked-byte
             (+ (bit-shift-left (Character/digit c1 16) 4)
                (Character/digit c2 16))))]
    (->> (partition 2 string)
         (map #(apply unhexify-2 %))
         byte-array)))

(defn bytes->hex
  "Convert byte sequence to hex string"
  [arr]
  (let [hex [\0 \1 \2 \3 \4 \5 \6 \7 \8 \9 \a \b \c \d \e \f]]
    (letfn [(hexify-byte [b]
              (let [v (bit-and b 0xFF)]
                [(hex (bit-shift-right v 4)) (hex (bit-and v 0x0F))]))]
      (apply str (mapcat hexify-byte arr)))))

(defn base58 [bytes] (Base58/encode bytes))
(defn base58->bytes [s] (Base58/decode s))

(defn bytes->ipfs-hash
  "Convert the ipfs bytes from a solana job to a CID.
  It prepends the 0x1220 to make it 34 bytes and Base58 encodes
  it. This result is IPFS addressable."
  [bytes]
  (->>  bytes byte-array bytes->hex (str "1220") hex->bytes Base58/encode))

(defn ipfs-hash->bytes
  "Convert IPFS hash to a jobs byte array

  It Base58 decodes the hash and drops the first 2 bytes as they are static for
  our IPFS hashses (0x1220, the 0x12 means Sha256 and 0x20 means 256 bits)"
  [hash]
  (->> hash Base58/decode (drop 2) byte-array))
