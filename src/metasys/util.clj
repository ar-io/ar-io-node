(ns metasys.util
  (:require [clojure.string :as str]))

(defn strip-quotes [s]
  (str/replace s #"^[\"](.*)[\"]$" "$1"))

(defn read-env
  ([]
   (read-env ".env.metasys"))
  ([env-path]
   (->> (slurp env-path)
        (str/split-lines)
        (remove #(str/starts-with? % "#")) ; Remove comments
        (remove #(str/blank? %)) ; Remove blank lines
        (map #(str/split % #"\s*=\s*")) ; Split key-value pairs
        (map (fn [[k v]] [k (strip-quotes v)])) ; Strip value leading and trailing quotes
        (into {}))))
