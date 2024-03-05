(ns metasys.tasks
  (:require [babashka.curl :as curl]
            [babashka.fs :as fs]
            [babashka.process :refer [check process]]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.string :as str])
  (:import [java.time LocalDateTime]
           [java.time.format DateTimeFormatter]))

(def diagrams (-> "docs/diagrams/diagrams.edn"
                  slurp
                  edn/read-string))

#_(defn pwd []
    (System/getProperty "user.dir"))

(def output-dir "docs/diagrams" #_(str (pwd) "docs/diagrams"))

(defn filetype [filename]
  (cond
    (re-find #"\.dot$" filename)
    :dot

    (re-find #"\.(puml|plantuml)$" filename)
    :plantuml))

(defn output-filename [src ext]
  (let [basename (-> src fs/components last)
        [file] (fs/split-ext basename)]
    (str output-dir "/" file "." (name ext))))

(defmulti render
  (fn [src output-format]
    [(filetype src) output-format]))

(defmethod render [:plantuml :png] [src output-format]
  (->> (process ["plantuml"
                 (str "-t" (name output-format))
                 "-o" output-dir src]
                {:err :string
                 :out :string})
       check))

(defmethod render [:dot :png] [src output-format]
  (let [output-ext (name output-format)]
    (->> (process ["dot"
                   (str "-T" output-ext)
                   "-o" (output-filename src output-ext) src]
                  {:err :string
                   :out :string})
         check)))

(defn build-diagrams []
  (doseq [[src {:keys [output-format]}] diagrams]
    (let [out (output-filename src output-format)]
      (when (not-empty (fs/modified-since out src))
        (render src output-format)))))

(defn git-checkout [h]
  (-> (process ["git" "checkout" h] {:err :string
                                     :out :string})
      check))

(defn commit-hash []
  (-> (process ["git" "rev-parse" "HEAD"] {:err :string
                                           :out :string})
      check
      :out
      str/trim-newline))

(defn previous-commit-hash []
  (-> (process ["git" "rev-parse" "HEAD^1"] {:err :string
                                             :out :string})
      check
      :out
      str/trim-newline))

(defn commit-message []
  (-> (process ["git" "log"  "--oneline"  "--format=%s" "-1"] {:err :string
                                                               :out :string})
      check
      :out
      str/trim-newline))

(defn changed-files []
  (-> (process ["git" "log"  "--oneline"  "--raw" "-1"] {:err :string
                                                         :out :string})
      check
      :out
      str/split-lines
      (->> (drop 1)
           (map #(str/split % #"\t"))
           (map last)
           (into #{}))))

(comment

  (commit-hash)

  (previous-commit-hash)

  (commit-message)

  (changed-files))

(defn notify-slack-diagram
  ([prefix src]
   (notify-slack-diagram prefix src nil))
  ([prefix src thread-ts]
   (when-let [{:keys [title output-format]} (diagrams src)]
     (when-let [image (output-filename src (name output-format))]
       (let [content (str "*" prefix " Diagram:* " title "\n"
                          "*Commit:* " (commit-message))]
         (-> (curl/post "https://slack.com/api/files.upload"
                        {:raw-args
                         (cond-> ["-H" (str "Authorization: Bearer " (System/getenv "SLACK_API_TOKEN"))
                                  "-F" (str "file=@" image)
                                  "-F" (str "initial_comment=" content)
                                  "-F" (str "channels=" (System/getenv "SLACK_CHANNEL"))]
                           thread-ts
                           (conj "-F" (str "thread_ts=" thread-ts)))})
             :body
             json/parse-string))))))

(defn to-pdf [image pdf]
  (->> (process ["convert" image pdf]
                {:err :string
                 :out :string})
       check))

(defn date-str []
  (let [fmt (DateTimeFormatter/ISO_DATE)]
    (-> (LocalDateTime/now)
        (.format fmt)
        str)))

(defn email-diagram [src]
  (when-let [{:keys [output-format]} (diagrams src)]
    (let [image (output-filename src (name output-format))
          pdf (-> image
                  fs/split-ext
                  first
                  (str "-" (date-str) ".pdf"))]
      (to-pdf image pdf)
      ;; TODO better email file name (tmp dir?)
      ;; TODO extract this
      (->> (process ["python3" "scripts/ses_pdf_email.py"]
                    {:extra-env {"EMAIL_FROM" (or (System/getenv "EMAIL_FROM")
                                                  "no-reply@ar-io.com")
                                 "EMAIL_TO" (System/getenv "EMAIL_TO")
                                 "PDF_FILE" pdf
                                 "OUTPUT_JSON_FILE" "email.json"}
                     :err :string
                     :out :string})
           check)
      ;; TODO extract this
      (->> (process ["aws" "ses" "send-raw-email" "--raw-message" (str "file://email.json") "--region" "us-east-1"]
                    {:err :string
                     :out :string})
           check))))

(defn send-diagram-notifications []
  (let [changed (changed-files)]
    (doseq [src changed]
      (when (diagrams src)
        (let [c (commit-hash)
              p (previous-commit-hash)]
          (build-diagrams)
          #_(email-diagram src)
          (let [resp (notify-slack-diagram "Updated" src)
                thread-ts (get-in resp ["file" "shares" "public" (System/getenv "SLACK_CHANNEL") 0 "ts"])]
            #_(when (fs/exists? src)
                (git-checkout p)
                (build-diagrams)
                (notify-slack-diagram "Previous" src thread-ts))
            #_(git-checkout c)))))))
