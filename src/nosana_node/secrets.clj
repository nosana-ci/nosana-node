(ns nosana-node.secrets
  (:require [clj-http.client :as http]
            [nosana-node.solana :as sol]
            [nosana-node.nosana :as nos]
            [taoensso.timbre :as log]
            [nosana-node.util :as util]
            [nos.core :as flow]
            [cheshire.core :as json]))

(defn- make-login-payload
  "Creates the HTTP payload for a login to the secrets engine.
  If `job-addr` is set this payload gives you access to the secrets of
  the job."
  [{:keys [signer] :as conf} job-addr]
  (let [ts      (quot (System/currentTimeMillis) 1000)
        msg     (-> (str "nosana_secret_" ts) (.getBytes "UTF-8"))
        sig     (sol/sign msg signer)
        payload (cond-> {:address   (.toString (:address conf))
                         :signature  (util/base58 sig)
                         :timestamp ts}
                  job-addr (assoc :job job-addr))]
    payload))

(defn login
  "Retrieves a JWT token to authenticate with the secrets manager."
  ([conf] (login conf nil))
  ([{:keys [secrets-endpoint] :as conf} job-addr]
   (let [payload (make-login-payload conf job-addr)]
     (try
       (->
        (http/post (str secrets-endpoint "/login")
                   {:form-params  payload
                    :content-type :json})
        :body
        (json/decode true)
        :token)
       (catch Exception e
         (log/errorf "Error when logging in to secrets %s" e)
         (throw (ex-info "Error when logging in to secrets" (ex-data e))))))))

(defn set-secrets
  "Sets a secrets map in the nosana secret proxy."
  [{:keys [secrets-endpoint] :as conf} secrets]
  (let [jwt (login conf)]
    (http/post (str secrets-endpoint "/secrets")
               {:form-params  {:secrets secrets}
                :content-type :json
                :headers      {"Authorization" jwt}
                :accept       :json})))

(defn get-secrets
  [{:keys [secrets-endpoint] :as conf} jwt]
  (try
    (->
     (http/get (str secrets-endpoint "/secrets")
               {:headers {"Authorization" jwt}})
     :body
     (json/decode false))
    (catch Exception e
      (throw (ex-info "Error fetching secrets" (ex-data e))))))

(derive :nosana/secret ::flow/ref)
(derive :nosana/secrets-jwt ::flow/ref)

(defmethod flow/ref-val :nosana/secret
  [[_ endpoint value keywordize?] flow-state vault]
  (log/log :info "Fetching secret " value)
  (let [account     (nos/get-signer-key vault)
        conf        {:signer           account
                     :secrets-endpoint endpoint
                     :address          (.getPublicKey account)}
        jwt         (login conf (:input/job-addr flow-state))
        secrets     (get-secrets conf jwt)
        keywordize? true]
    (if (contains? secrets value)
      (cond-> (get secrets value)
        keywordize? clojure.walk/keywordize-keys)
      (throw (ex-info (str "Could not find secret " value) {})))))

(defmethod flow/ref-val :nosana/secrets-jwt
  [[_ endpoint] flow-state vault]
  (log/log :info "Generating secrets login token")
  (let [account     (nos/get-signer-key vault)
        conf        {:signer           account
                     :secrets-endpoint endpoint
                     :address          (.getPublicKey account)}]
    (login conf (:input/job-addr flow-state))))


;; nosana-node.core/secret can be used to retreive values from the secret engine
;; examples:

#_(flow/run-flow!
   (:nos/flow-engine system)
   (flow/build
    {:ops [{:op :nos/prn :args [[:nosana/secret "http://localhost:4124" "testing"]]}]}));
