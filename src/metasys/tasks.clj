(ns metasys.tasks
  (:require [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [metasys.config :as cfg]
            [taoensso.timbre :as log]))

(defn read-oi-knowledge
  ([]
   (read-oi-knowledge "oi-knowledge.edn"))
  ([path]
   (-> path
       slurp
       edn/read-string)))

(defn update-oi-knowledge []
  (let [oi-knowledge (read-oi-knowledge)]
    (doseq [{:keys [id files]} oi-knowledge
            :let [k-id id]]
      (log/infof "Updating knowledge %s..." k-id)
      (doseq [{:keys [id path]} files
              :let [f-id id
                    f-url (str cfg/oi-base-url "/api/v1/files/" f-id "/data/content/update")
                    k-url (str cfg/oi-base-url "/api/v1/knowledge/" k-id "/file/update")]]
        (log/infof "Updating file %s with contents of %s..." f-id path)
        (http/post f-url {:headers {:content-type "application/json"}
                          :oauth-token cfg/oi-api-key
                          :body (json/generate-string {"content" (slurp path)})})
        (log/infof "Updating file %s in knowledge..." f-id k-id path)
        (http/post k-url {:headers {:content-type "application/json"}
                          :oauth-token cfg/oi-api-key
                          :body (json/generate-string {"file_id" f-id})}))
      (log/infof "Knowledge %s updates complete." k-id))
    (log/info "All updates complete.")))

(comment
  (read-oi-knowledge))
