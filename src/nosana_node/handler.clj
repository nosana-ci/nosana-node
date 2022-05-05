(ns nosana-node.handler
  (:require [integrant.core :as ig]
            [ataraxy.response :as response]))

(defmethod ig/init-key :nos.handler/health [_ options]
  (fn [{[_] :ataraxy/result}]
    [::response/ok "OK"]))
