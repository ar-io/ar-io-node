(ns metasys.config
  (:require [clojure.string :as str]
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

(defn env [v]
  (or (System/getenv v)
      (dot-env v)))

(def oi-api-key (env "OI_API_KEY"))
(def oi-base-url (env "OI_BASE_URL"))

(comment
  (read-env)
  (env "OI_BASE_URL"))
