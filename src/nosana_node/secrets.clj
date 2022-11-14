(ns nosana-node.secrets
  (:require [clj-http.client :as http]
            [nosana-node.solana :as sol]
            [nosana-node.util :as util]
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

(defn set-secret [{:keys [secrets-endpoint]:as conf} secret]
  (let [jwt (login conf)]
    (http/post (str secrets-endpoint "/secrets")
               {:form-params {:secrets secret}
                :content-type :json
                :headers {"Authorization" jwt}
                :accept :json})))
