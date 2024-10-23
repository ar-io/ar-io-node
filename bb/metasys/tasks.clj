(ns metasys.tasks
  (:require [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.string :as str]
            [taoensso.timbre :as log]))

(defn strip-quotes [s]
  (clojure.string/replace s #"^[\"](.*)[\"]$" "$1"))

(defn read-env []
  (->> (slurp ".env")
       (str/split-lines)
       (remove #(str/starts-with? % "#")) ; Remove comments
       (remove #(str/blank? %)) ; Remove blank lines
       (map #(str/split % #"\s*=\s*")) ; Split key-value pairs
       (map (fn [[k v]] [k (strip-quotes v)])) ; Strip value leading and trailing quotes
       (into {})))

;; Read and parse .env into a map
(def env (read-env))

(def oi-api-key (env "OI_API_KEY"))
(def oi-url (env "OI_URL"))

(def oi-knowledge (-> "oi-knowledge.edn" slurp edn/read-string))

(defn update-oi-knowledge []
  (doseq [[k-id k] oi-knowledge]
    (doseq [[f-id path] (:files k)
            :let [f-url (str oi-url "/api/v1/files/" f-id "/data/content/update")
                  k-url (str oi-url "/api/v1/knowledge/" k-id "/file/update")]]
      (log/infof "Updating file %s in knowledge %s with contents of %s..." f-id k-id path)
      (http/post f-url
                 {:headers {:content-type "application/json"}
                  :oauth-token oi-api-key
                  :body (json/generate-string {"content" (slurp path)})})
      (log/infof "Updating file %s in knowledge %s..." f-id k-id path)
      (http/post k-url
                 {:headers {:content-type "application/json"}
                  :oauth-token oi-api-key
                  :body (json/generate-string {"file_id" f-id})})
      (log/info "Updates complete."))))
