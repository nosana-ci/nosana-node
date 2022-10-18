(ns nosana-node.pipeline
  (:require [clojure.edn :as edn]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clj-yaml.core :as yaml]
            [nos.core :as nos]
            [clj-yaml.core :as yaml]
            [clojure.string :as string]))

(def example-job
  {:type     "Github"
   :url      "https://github.com/nosana-ci/nosana.io"
   :commit   "ef840c0614b0abd2de0816304febeff0296926e0"
   :pipeline "commands:\n  - yarn install --immutable\n  - yarn lint\n#  - yarn test:ci:storage-ui\n# docker image to run above commands\nimage: node"})

(def base-flow
  {:ops
   [{:op   :docker/run
     :id   :checkout
     :args [{:cmds [{:cmd [::nos/str "git clone " [::nos/ref :input/repo] " project"]}
                    {:cmd      [::nos/str "git checkout " [::nos/ref :input/commit-sha]]
                     :work-dir "/root/project"}]
             :artifacts [{:source "project" :dest "checkout"}]
             :image "registry.hub.docker.com/bitnami/git:latest"}]}]})

(defn make-job
  "Create flow segment for a `job` entry of the pipeline."
  [{:keys [name commands artifacts resources environment image]
    :or   {resources []}}
   global-image
   global-environment]
  {:op   :docker/run
   :id   (keyword name)
   :args [{:cmds      (map (fn [c] {:cmd c}) commands)
           :image     (or image global-image)
           :env       (merge global-environment environment)
           :conn      {:uri [::nos/vault :podman-conn-uri]}
           :work-dir  "/root/project"
           :resources (cons {:source "checkout" :dest "/root"}
                            (map (fn [r] {:source r :dest "/root"}) resources))
           :artifacts (map (fn [a] {:source (:path a) :dest (:name a)}) artifacts)}]
   :deps [:checkout]})

(defn pipeline->flow-ops
  [{:keys [nos global jobs]}]
  (let [work-dir "/root"
        {:keys [environment allow-failure image]} global]
    (map #(make-job % image environment) jobs)))

(defn load-yml
  "Expects a trigger section in the yaml"
  [path]
  (let [{:keys [trigger global jobs] :as pipeline}
        (-> path slurp yaml/parse-string)]
    (-> base-flow
        (update :ops concat (pipeline->flow-ops pipeline))
        (assoc-in [:results :input/repo] (:repo trigger))
        (assoc-in [:results :input/commit-sha] (:commit-sha trigger)))))

(defn make-from-job
  [job job-addr run-addr]
  (let [flow   (-> base-flow
                   (update :ops concat (pipeline->flow-ops (:pipeline job)))
                   (assoc-in [:results :input/repo] (:url job))
                   (assoc-in [:results :input/commit-sha] (:commit job))
                   (assoc-in [:results :input/job-addr] (.toString job-addr))
                   (assoc-in [:results :input/run-addr] (.toString run-addr)))
        last-op-id (-> flow :ops last :id)
        wrap-up-op {:op :fx :id :wrap-up :args [[:nos.nosana/complete-job]] :deps [last-op-id]}]
    (->
     flow
     (update :ops conj wrap-up-op)
     nos/build)))
