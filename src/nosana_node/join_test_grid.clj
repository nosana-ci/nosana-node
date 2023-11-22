(ns nosana-node.join-test-grid
  "Functions for handling the `join-test-grid` command"
  (:require
   [taoensso.timbre :as log]
   [nosana-node.nosana :as nos]
   [nosana-node.solana :as sol]
   [clojure.core.async :as async :refer
    [<!! <! >!! go go-loop >! timeout chan]]))

(defn has-jobs?
  "Check if the test grid market still has jobs."
  [conf]
  (let [market (nos/get-market conf)]
    (and (= (:queueType market) 0)
         (not-empty (:queue market)))))

(defn get-test-grid-run
  "Get run for this node on the test grid.
  Will enter the market if necessary."
  [conf]
  (go
    (if-let [run (nos/find-next-run conf)]
      ;; if we already have a run we can use that
      run
      ;; else we will enter the market and return the run
      (cond
        (not (has-jobs? conf))
        {:error "There is currently no availability on the Test Grid." :ok? true}

        :else
        (let [_ (println "Entering the market")
              sig (nos/enter-market conf)
              tx (<! (sol/await-tx< sig (:network conf)))]
          ;; TODO: error handling
          ;; after entering the market we should have a job assigned
          (if-let [run (nos/find-next-run conf)]
            run
            {:error "Could not find a Test Grid slot, please try again later." :ok? true}))))))

(defn print-results [sig run-addr flow]
  ;; TODO: print which GPU was detected, formatting
  (println "Benchmark finished.")
  (println "Receipt" sig "\n")
  (println "---\n")
  (println "Test Grid Registration code: " run-addr))

(defn join-test-grid
  "Handle the `join-test-grid` command."
  [{:nos/keys [conf] :as system}]
  ;; TODO: in general we should improve the information printed to
  ;; console during this process.

  ;; it might be good to hide some verbose logs from this point
  (log/set-min-level! :warn)

  (go
    (let [run (<! (get-test-grid-run conf))]
      (cond
        (:error run)
        (do
          (println (:error run))
          (System/exit (if (:ok? run) 0 1)))

        :else
        (do
          (println "Found a Test Grid assignment, starting benchmark...\n")

          ;; we can subscribe to a channel that will receive the run results when finished
          (let [finish-flow-chan (nos/subscribe-to-finished-flows system)
                flow-id (nos/start-flow-for-run! run conf system)

                result
                ;; this will either return the flow results or timeout
                (async/alt!
                  finish-flow-chan
                  ([[_ flow-id flow]]
                   (println "Benchmark finished, posting results\n")
                   {:sig (<! (nos/finish-flow-2 flow conf))
                    :flow flow})

                  ;; TODO: does this timeout make sense?
                  (timeout 5000)
                  {:error "Error: timed out while waiting for benchmark results."})]
            (if (:error result)
              (do
                (println (:error result))
                (System/exit 1))
              (print-results (:sig result) (first run) (:flow result)))))))))
