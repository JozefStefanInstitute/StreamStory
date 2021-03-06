#!/bin/bash

CONF_FILE=$1

if [ -z $CONF_FILE ]; then
	echo 'Usage: run.sh path/to/config.json'
	exit 1
fi

while true; do
	echo 'Running StreamStory ...'
	node main.js $CONF_FILE
	sleep 1
done
