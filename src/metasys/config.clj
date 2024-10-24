(ns metasys.config
  (:require [clojure.edn :as edn]
            [metasys.util :as util]))

(def env (util/read-env))

(def oi-api-key (env "OI_API_KEY"))
(def oi-base-url (env "OI_BASE_URL"))

(def oi-knowledge (-> "oi-knowledge.edn" slurp edn/read-string))
