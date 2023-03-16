(ns nosana-node.pipeline-test
  (:require
   [clojure.test :refer [deftest is testing]]
   [failjure.core :as f]
   [clojure.core.async :as a :refer [>! <! >!! <!! go go-loop chan
                                     put!]]
   [nosana-node.gitlab :as gitlab]
   [nosana-node.pipeline :as pipeline]))

(pipeline/load-yml (clojure.java.io/resource "pipeline3.yml"))

(def pipeline-yml {:trigger {:repo       "https://github.com/unraveled/dummy.git"
                             :commit-sha "324921ccbfb5c04cca80429fe0d7eceb4210c732"}
                   :global  {:image       "registry.hub.docker.com/library/node:16"
                             :environment {"APP_ENV" "production"}}
                   :jobs    [{:name        "list-directory"
                              :environment {"SECRET" "value"}
                              :commands    ["ls -l"]}]})

(deftest make-job-test
  (let [job (pipeline/make-job (get-in pipeline-yml [:jobs 0]) pipeline-yml )]
    (testing "make pipeline job from yml"
      (is (= (:id job) :list-directory))
      (is (= (get-in job [:args :image]) (get-in pipeline-yml [:global :image]))
          "should use global image"))))

#_(deftest make-from-job-test
  (let [job-addr "42zzVGgo1snMgUXesmHQxpZFHvoTGG6aBDJVMh5BWVLt"
        run-addr "4HoZogbrDGwK6UsD1eMgkFKTNDyaqcfb2eodLLtS8NTx"
        job      {:url      "https://github.com/unraveled/dummy.git"
                  :commit   "324921ccbfb5c04cca80429fe0d7eceb4210c732"
                  :job      job-addr
                  :run      run-addr
                  :pipeline pipeline-yml}]
    (testing "make flow from job"
      (let [flow (pipeline/make-from-job job job-addr run-addr)]
        (is (= (get-in job [:args 0 :env "NOS_COMMIT_SHA"])
               "324921ccbfb5c04cca80429fe0d7eceb4210c732")
            "env should contain global vars")))))
