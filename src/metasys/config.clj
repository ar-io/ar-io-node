(ns metasys.config
  (:require [clojure.edn :as edn]
            [clojure.string :as str]
            [metasys.util :as util]))

(defn read-env
  ([]
   (read-env ".env.metasys"))
  ([env-path]
   (->> (slurp env-path)
        (str/split-lines)
        (remove #(str/starts-with? % "#")) ; Remove comments
        (remove #(str/blank? %)) ; Remove blank lines
        (map #(str/split % #"\s*=\s*")) ; Split key-value pairs
        (map (fn [[k v]] [k (util/strip-quotes v)])) ; Strip value leading and trailing quotes
        (into {}))))

(def dot-env (read-env))

(defn env [vname]
  (or (System/getenv vname)
      (dot-env vname)))

(def oi-api-key (env "OI_API_KEY"))
(def oi-base-url (env "OI_BASE_URL"))

(def oi-knowledge (-> "oi-knowledge.edn"
                      slurp
                      edn/read-string))
