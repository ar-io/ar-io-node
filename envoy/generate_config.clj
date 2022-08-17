#!/usr/bin/env bb

(require '[clojure.string :as str])
(require '[selmer.parser :as selmer])

(defn extract-hosts [s]
  (some-> s
          (str/split #",")
          (->> (map #(str/split % #":"))
               (map (fn [[h p]] {:hostname h :port p})))))

(defn getenv-hosts [s]
  (-> s System/getenv extract-hosts))

(def full-chain-nodes
  (or (getenv-hosts "ARWEAVE_FULL_CHAIN_NODES")
      (getenv-hosts "ARWEAVE_NODES")))

(def partial-chain-nodes
  (or (getenv-hosts "ARWEAVE_PARTIAL_CHAIN_NODES")
      (getenv-hosts "ARWEAVE_NODES")))

(def chunk-nodes
  (or (getenv-hosts "ARWEAVE_CHUNK_NODES")
      (getenv-hosts "ARWEAVE_NODES")))

(def ario-gateways
  ( getenv-hosts "ARIO_GATEWAYS"))

(when *command-line-args*
  (assert full-chain-nodes "No full chain nodes found")
  (assert partial-chain-nodes "No partial chain nodes found")
  (assert chunk-nodes "No chunk nodes found")
  (assert ario-gateways "No ario gateways found")

  (-> *command-line-args*
      first
      slurp
      (selmer/render {
                      :ario_gateways ario-gateways
                      :full_chain_nodes full-chain-nodes
                      :partial_chain_nodes partial-chain-nodes
                      :chunk_nodes chunk-nodes})
      print))

(comment 

  (extract-hosts nil)

  (extract-hosts "a:1,b:2,c:3")

  (selmer/render (slurp "envoy.yaml.template")
                 {                     
                  :ario_gateways (extract-hosts "a:1,b:2,c:3")
                  :full_chain_nodes (extract-hosts "d:1,e:2,f:3")
                  :partial_chain_nodes (extract-hosts "g:4,h:5,i:6")
                  :chunk_nodes (extract-hosts "j:7,k:8,l:9")})
)