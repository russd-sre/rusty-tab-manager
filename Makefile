NAME = rusty-tab-manager
FILES = manifest.json background.js popup.html popup.js icons/

.PHONY: zip clean

zip: $(NAME).zip

$(NAME).zip: $(FILES)
	rm -f $@
	zip -r $@ $(FILES)

clean:
	rm -f $(NAME).zip
