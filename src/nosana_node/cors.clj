(ns nosana-node.cors)

;; Simple Ring middleware that allows all CORS

(def cors-headers
  "Generic CORS headers"
  {"Access-Control-Allow-Origin"  "*"
   "Access-Control-Allow-Headers" "*"
   "Access-Control-Allow-Methods" "GET"})

(defn preflight?
  "Returns true if the request is a preflight request"
  [request]
  (= (request :request-method) :options))

(defn wrap-all-cors
  "Allow requests from all origins - also check preflight"
  [handler]
  (fn [request]
    (if (preflight? request)
      {:status 200
       :headers cors-headers
       :body "preflight complete"}
      (let [response (handler request)]
        (update-in response [:headers]
                   merge cors-headers )))))
