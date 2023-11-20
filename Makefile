# Renders PlantUML and Graphviz dot diagrams source files in 'docs/diagrams'

.PHONY: all dot_files puml_files

plantuml_version := 1.2023.12
plantuml_jar := plantuml-$(plantuml_version).jar
plantuml_jar_path := vendor/$(plantuml_jar)

dot_pngs := $(patsubst docs/diagrams/src/%.dot,docs/diagrams/%.png,$(wildcard docs/diagrams/src/*.dot))
puml_pngs := $(patsubst docs/diagrams/src/%.puml,docs/diagrams/%.png,$(wildcard docs/diagrams/src/*.puml))

all: $(plantuml_jar_path) $(dot_pngs) $(puml_pngs)

# Download PlantUML jar
$(plantuml_jar_path):
	mkdir -p vendor
	curl -L -o $(plantuml_jar_path) https://github.com/plantuml/plantuml/releases/download/v$(plantuml_version)/$(plantuml_jar)

# Render Graphviz dot files
$(dot_pngs): docs/diagrams/%.png: docs/diagrams/src/%.dot
	dot -Tpng -o $@ $<

# Render PlantUML files
$(puml_pngs): docs/diagrams/%.png: docs/diagrams/src/%.puml
	java -jar $(plantuml_jar_path) -o $(CURDIR)/docs/diagrams -tpng $<
