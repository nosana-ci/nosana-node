(ns nosana-node.core-test
  (:require
   [clojure.test :refer [deftest is testing]]
   [clojure.string :as string]
   [nos.core :as flow]
   [konserve.memory :refer [new-mem-store]]
   [clojure.core.async :as a :refer [>! <! >!! <!! go go-loop chan
                                     put!]]
   [nosana-node.gitlab :as gitlab]
   [nosana-node.pipeline :as pipeline]))

(defn- test-flow-engine []
  {:store (<!! (new-mem-store))
   :chan  (chan)
   :vault {:secret 42}})

(defn run-flow [flow]
  (let [fe (test-flow-engine)]
    (->>
     (flow/run-flow! fe flow)
     )))

(def flow-1 (-> {:default-args {:container/run {:inline-logs? true}}
                 :ops [{:op   :container/run
                        :id   "run"
                        :args {:image        "alpine"
                               :cmds         [{:cmd "echo hi"}]}}]}
                flow/build))

(deftest flow-output
  (testing "can run a simple flow"
    (let [flow-res (run-flow flow-1)
          res      (:state flow-res)]
      (is (map? res))
      (is (keys res) ["run"])
      (is (= :success (get-in res ["run" 0])))
      (is (= (get-in res ["run" 1 1 :log])
             "[[1,\"hi\\n\"],[1,\"\"]]")))))

(deftest flow-errors
  (testing "error handling for unknown image"
    (let [flow-res (run-flow (assoc-in flow-1 [:ops 0 :args :image] "alpinexx"))
          res      (:state flow-res)]
      (is (= :nos/error (get-in res  ["run" 0])))
      (is (string/starts-with? (get-in res ["run" 1]) "HTTP Error: 500"))
      (is (string/includes? (get-in res ["run" 1])
                            "alpinexx: image not known"))
      (is (empty? (get-in res ["run" 2])))))

  (testing "error for unkown command"
    (let [flow-res (run-flow (assoc-in flow-1 [:ops 0 :args :cmds 0 :cmd] "cd none"))
          res      (:state flow-res)]
      (is (= :nos/error (get-in res ["run" 0])))
      (is (string/includes? (get-in res ["run" 1])
                            "executable file `cd` not found in $PATH:")))))
