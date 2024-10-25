(ns metasys.util
  (:require [clojure.string :as str]))

(defn strip-quotes [s]
  (str/replace s #"^[\"](.*)[\"]$" "$1"))
