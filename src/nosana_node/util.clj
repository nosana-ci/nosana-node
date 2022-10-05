(ns nosana-node.util
  (:import java.security.MessageDigest))

(defn sha256
  "Convert a string to sha256 checksum as a hex string"
  [string]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") (.getBytes string "ASCII"))]
    (apply str (map (partial format "%02x") digest))))
