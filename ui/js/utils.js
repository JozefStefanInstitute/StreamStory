function isNumber(val) {
	return !isNaN(val);
}

function isInt(val) {
	if (isNaN(val)) return false;
	return parseFloat(val) == parseInt(val);
}

function clone(obj) {
	return JSON.parse(JSON.stringify(obj));
}

function getTimeUnit() {
	return $('#span-tu').html();
}

function formatDate(date) {
	var year = date.getFullYear();
	var month = date.getMonth() + 1;
	var day = date.getDate();
	
	if (month < 10) month = '0' + month;
	if (day < 10) day = '0' + day;
	
	return day + '/' + month + '/' + year;
}

function formatDateTime(date) {
	var hour = date.getHours();
	var minute = date.getMinutes();
	var second = date.getSeconds();
	
	if (hour < 10) hour = '0' + hour;
	if (minute < 10) minute = '0' + minute;
	if (second < 10) second = '0' + second;
	
	return formatDate(date) + ' ' + hour + ':' + minute + ':' + second;
}

function handleAjaxError(alertField, callback) {
	return function (xhr, status, err) {
		if (xhr.readyState == 0) {
			console.log('Ajax error with request not initialized!');
		} else {
			if (xhr.status == 400 && alertField != null) {
				showAlert($('#alert-holder'), alertField, 'alert-danger', xhr.responseText, null, false);
			} else {
				alert(xhr.responseText);
			}
			
			if (callback != null)
				callback();
		}
	}
}

function addPressHandler(btn, callback) {
	var timeoutId = 0;
	var intervalId = 0;
	
	btn.click(function (event) {
		if (event.which != 1) return;
		
		callback(event);
	});
	btn.mousedown(function (event) {
		if (event.which != 1) return;	// only listen to the left mouse button
		
		timeoutId = setTimeout(function () {
			// the button is pressed
			timeoutId = null;
			intervalId = setInterval(function () {
				callback(event);
			}, 50);
		}, 1000);
	}).bind('mouseup mouseleave', function () {
		if (timeoutId != null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if (intervalId != null) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}

function countDecimals(value) {
    if(Math.floor(value) === value) return 0;
    return value.toString().split(".")[1].length || 0; 
}

function toUiPrecision(val) {
	if (val > 1000) {
		return val.toFixed();
	} else {
		var decimals = countDecimals(val);
		if (decimals == 0)
			return val.toFixed();
		else
			return val.toPrecision(Math.min(decimals, 3));
	}
}

function showAlert(holder, wrapper, clazz, title, msg, close) {
	wrapper.children('div').alert('close');
	wrapper.html(holder.html());
	
	var alertDiv = wrapper.children('div');
	
	alertDiv.removeClass('alert-danger');
	alertDiv.removeClass('alert-success');
	alertDiv.addClass(clazz);
	
	if (title != null)
		alertDiv.children('.alert-title').html(title);
	if (msg != null)
		alertDiv.children('.alert-text').html(msg);
	
	alertDiv.alert();
	
	if (close == true) {
		setTimeout(function () {
			alertDiv.alert('close');
		}, 5000);
	}
}

function redirectToUI() {
	window.location.replace('ui.html');
}

function reloadWindow() {
	window.location.reload();
}

function getFtrColor(val, minVal, maxVal, middleVal) {
	if (middleVal == null) middleVal = 0;
	
	var negColor = [0,0,255];	// purple
	var posColor = [255,128,0];	// yellow
	
	var baseColor = val > middleVal ? posColor : negColor;
	var colorWgt = val > middleVal ? (val - middleVal) / (maxVal - middleVal) : (val - middleVal) / (minVal - middleVal);
	
	var color = [];
	for (var i = 0; i < baseColor.length; i++) {
		color.push((baseColor[i]*colorWgt).toFixed());
	}
	
	return 'rgb(' + color.join(',') + ')';
}

$(document).ready(function () {
	var tooltipElements = $('[rel=tooltip]');
	
	tooltipElements.qtip({
		content: {
			title: function (event, api) {
				return $(this).attr('title');
			},
			text: function (event, api) {
				return $(this).attr('content');
			}
		},
		style: {
			classes: 'qtip-bootstrap'
		}
	});
});