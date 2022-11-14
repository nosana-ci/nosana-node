(ns nosana-node.secrets
  (:require [clj-http.client :as http]
            [nosana-node.solana :as sol]
            [nosana-node.nosana :as nos]
            [nosana-node.util :as util]
            [nos.core :as flow]
            [cheshire.core :as json]))

(defn- make-login-payload [{:keys [signer] :as conf}]
  (let [ts  (quot (System/currentTimeMillis) 1000)
        msg (-> (str "nosana_secret_" ts) (.getBytes "UTF-8"))
        sig (sol/sign msg signer)
        payload {:address
                 (.toString (:address conf))
                 :signature
                 (util/base58 sig)
                 :timestamp ts
                 ;;:job "addr" ;; TODO: access secrets for project of assigned job
                 }]
    payload))

(defn login [{:keys [secrets-endpoint]:as conf}]
  (let [payload (make-login-payload conf)]
    (->
     (http/post (str secrets-endpoint "/login")
                {:form-params (make-login-payload conf)
                 :content-type :json})
     :body
     (json/decode true)
     :token)))

(defn set-secrets
  "Set a secrets map in the nosana secret proxy."
  [{:keys [secrets-endpoint] :as conf} secrets]
  (let [jwt (login conf)]
    (http/post (str secrets-endpoint "/secrets")
               {:form-params {:secrets secrets}
                :content-type :json
                :headers {"Authorization" jwt}
                :accept :json})))

(defn get-secrets [{:keys [secrets-endpoint] :as conf} jwt]
  (->
   (http/get (str secrets-endpoint "/secrets")
             {:headers {"Authorization" jwt}})
   :body
   (json/decode false)))

(derive :nosana-node.core/secret ::flow/ref)
(defmethod flow/ref-val :nosana-node.core/secret
  [[_ endpoint value] flow-state vault]
  (let [account (nos/get-signer-key vault)
        conf    {:signer           account
                 :secrets-endpoint endpoint
                 :address          (.getPublicKey account)}
        jwt     (login conf)
        secrets (get-secrets conf jwt)]
    (get secrets value)))

;; nosana-node.core/secret can be used to retreive values from the secret engine
;; example:
#_(flow/run-flow!
   (:nos/flow-engine system)
   (flow/build
    {:ops [{:op :prn :args [[:nosana-node.core/secret "http://localhost:4124" "jesse"]]}]}))
