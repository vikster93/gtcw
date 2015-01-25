'use strict'

var https = require('https'),
    cheerio = require('cheerio'),
    monk = require('monk'),
    poller_interval = null;

function CourseConnector(connection_url, term_mgr) {
	var db = monk(connection_url);
	this.term_mgr = term_mgr;
	this.course_info = db.get('course_info');
	this.term_courses = db.get('term_courses');
	this.dispatch_delay_ms = 25;
	this.active_probe_q = [];
	this.check_active = false;
};


CourseConnector.prototype.check_probe_q = function() {
	var _this = this;

	if(this.active_probe_q.length > 0) {
		var crn_test_fcall = this.active_probe_q.shift();
		_this.check_active = true;
		_this.crn_path_valid(crn_test_fcall);
		setTimeout(function() {
			_this.check_probe_q();
		}, _this.dispatch_delay_ms);
	} else {
		_this.check_active = false;
	}

}

CourseConnector.prototype.alert_q = function() {
	if (!this.check_active) {
		this.check_probe_q();	
	}
};

CourseConnector.prototype.start_unprobed_term_poller = function(delay) {
	_this = this;

	poller_interval = setInterval(function() {
		_this.poll_unprobed_terms(function(unprobed) {
			if(unprobed) {
				unprobed.forEach(function(e) {
					_this.probe_term_for_crns(e.code);
				});
			}
		});
	}, delay);
};

CourseConnector.prototype.stop_unprobed_term_poller = function() {
	if(poller_interval) {
		clearInterval(poller_interval);
	}
};

CourseConnector.prototype.poll_unprobed_terms = function(cb) {
	this.term_mgr.get_unprobed_terms(cb);
};

CourseConnector.prototype.probe_term_for_crns = function(term_code) {
  var pathComponents= [
  	'/pls/bprod/bwckschd.p_disp_detail_sched?term_in=',
  	'4digityear',
  	'2digitmonth',
  	'&crn_in=',
  	'crn_val'
  ],
  	term_period = this.term_mgr.decompose_term_code(term_code),
  	start_crn = 20000,
  	stop_crn = 29999,
  	// stop_crn = 99999,
  	_this = this;

	for(var i=start_crn; i<=stop_crn; i++) {
		pathComponents[1] = term_period.year;
		pathComponents[2] = term_period.month;
		pathComponents[4] = i;
		var path_to_probe = pathComponents.join('');

		var transition_cb = function(is_valid, $, term_code, path) {			
			if(is_valid) {
				_this.parse_class_info($, term_code, path);
			}
		}

		this.active_probe_q.push([i, term_code, path_to_probe, transition_cb]);
		this.alert_q();
	};

};

//Probe PHASE 1
CourseConnector.prototype.crn_path_valid = function(crn, term, path, cb) {
  var _this = this;

  if(arguments.length == 1) {
  	var crn = arguments[0][0],
  		term = arguments[0][1],
  		path = arguments[0][2],
  		cb = arguments[0][3]
  }


  this.term_courses.find({term_code: term, crn: crn})
	.on('success', function (docs) {
  	if(docs.length == 0) {
  		_this.gt_https_req(path, function($){
		  	var err_txt = $('.errortext');
	      if(!err_txt.length) {
	      	cb(true, $, term, path);
	      } else {
	      	cb(false, null, term, path);
	      }
  		});

  	} else {
  		cb(false, null, term, path);
  	}
	})
	.on('error', function(err){
		console.log(err);
	});

};


//Probe PHASE 2
"'Detailed Class Information' page"
CourseConnector.prototype.parse_class_info = function($, term, path) {
	var _this = this;

	console.log(path);

	$('a').each(function() {
		if(_this.link_to_text(this) == 'View Catalog Entry') {
			_this.parse_catalog_entry(term, this.attribs.href);			
		}
	});
};

"'Detailed Class Information' page"
CourseConnector.prototype.parse_catalog_entry = function(term, path) {
	var _this = this;

	this.gt_https_req(path, function($){
		var class_title_e = $('.nttitle a'),
				class_title_txt = _this.link_to_text(class_title_e['0']);

		if($('.ntdefault').html()) {
			var course_info_comps = $('.ntdefault').html().split('<br>');			
		}else{
			var course_info_comps = null;		
		}


		if(class_title_txt) {
			var title_comps = class_title_txt.split('-'),
					tmp = title_comps[0].trim(),
					tmp = tmp.split(' '),
					subj = tmp[0],
					course_num = tmp[1],
					course_title = title_comps[1].trim();

			var course_info_obj = {
				subj: subj,
				num: course_num,
				title: course_title
			}

			_this.course_info.find(course_info_obj)
			.on('success', function(docs) {
				//If the course isn't present in the catalog, parse and add it.
				if(docs.length == 0) {

					var step_idx = 0;
					var translate_step = {
						0 : 'desc',
						1 : 'credit_hrs',
						2 : 'lect_hrs',
					};

					for(var i in course_info_comps) {
						var test = course_info_comps[i].trim();

						if(test.length != 0 && step_idx < 3) {
							var translation = translate_step[step_idx];

							if(translation != 'noop') {
								course_info_obj[translation] = test;
							}
							step_idx++;
						}
					}

					course_info_obj.credit_hrs = course_info_obj.credit_hrs.split(' ')[0];
					course_info_obj.lect_hrs = course_info_obj.lect_hrs.split(' ')[0];

					var grade_basis = course_info_comps.filter(function(e) {
						return e.match(/span/);
					});

					if(grade_basis.length) {
						grade_basis = grade_basis[0].split('>').pop();
						course_info_obj.grade_basis = grade_basis.trim();
					}

					var dept = course_info_comps.filter(function(e) {
						return e.match(/Depart|Dept/i);
					});

					if(dept.length) {
						course_info_obj.dept = dept[0].trim();
					}

					_this.course_info.insert(course_info_obj);
				}
			});

		}

		if(course_info_comps) {
			//Find the Schedule listings page path to probe.
			var sched_listing_href = course_info_comps.filter(function(e) {
				return e.match(/href/);
			});

			if(sched_listing_href.length) {
				var sched_txt = sched_listing_href[0].trim(),
						start_link_idx = sched_txt.indexOf('"'),
						end_link_idx = sched_txt.indexOf('"', start_link_idx + 1);
				
				if(start_link_idx != -1 && end_link_idx != -1) {
					var sched_path = sched_txt.slice(start_link_idx+1, end_link_idx),
							sched_path = sched_path.replace(/&amp;/g, '&');

					_this.parse_schedule_listing(term, sched_path);
				}
			}

		}

	});
};

"'Detailed Class Information' page"
CourseConnector.prototype.parse_schedule_listing = function(term, path) {
	var _this = this;
	// console.log(path);

	_this.gt_https_req(path, function($) {
		$('.datadisplaytable[summary="This layout table is used to present the sections found"] > tr')
		.each(function(i, row){
			var section_header = $(row).children('th')['0'];

			if(section_header) {
				var header_link = $(section_header).children('a')['0'],
						header_txt = $(header_link).text(),
						header_comps = header_txt.split('-');

				eval_sect_title(header_comps, function(sect_obj) {
					if(sect_obj) {
						var next_row = $(row).next(),
								data_cell = $(next_row).children('td')['0'],
								meeting_rows = $(data_cell).find('tr').slice(1);

								sect_obj.meetings = []

								//Parse the meeting time tables
								meeting_rows.each(function(meeting_idx, meeting_row) {
									sect_obj.meetings.push({});
									$(meeting_row).find('td').each(function(cell_idx,data_cell) {
										var cur_meeting = sect_obj.meetings[meeting_idx],
												cell_contents = $(data_cell).text();

										if(cell_idx == 1) {
											var time_comps = cell_contents.split('-');
											if (time_comps.length == 2) {
												cur_meeting.start_time = time_comps[0].trim();
												cur_meeting.end_time = time_comps[1].trim();												
											}else {
												cur_meeting.start_time = time_comps[0].trim();
												cur_meeting.end_time = time_comps[0].trim();																							
											}
										}else if(cell_idx == 2) {
											cur_meeting.days = cell_contents.trim();
										}else if(cell_idx == 3) {
											cur_meeting.location = cell_contents.trim();											
										}else if(cell_idx == 4) {
											var date_comps = cell_contents.split('-');
											cur_meeting.start_date = date_comps[0].trim();
											cur_meeting.end_date = date_comps[1].trim();
										}else if(cell_idx == 5) {
											cur_meeting.type = cell_contents.trim();
										}else if(cell_idx == 6) {
											cur_meeting.instructor = cell_contents.trim();
										}

									});
								});

								var upper_table = $(next_row).html().split('<br>');
								parse_upper_table(upper_table, sect_obj, function(sect_obj) {
									_this.term_courses.insert(sect_obj);
								});
					}
				});
			}


		});
	});

	function parse_meeting_table(meeting_rows, sect_obj, cb) {
		sect_obj.meetings = [];
		console.log('entr meeting table');

		//Parse the meeting time tables
		meeting_rows.each(function(meeting_idx, meeting_row) {
			sect_obj.meetings.push({});
			$(meeting_row).find('td').each(function(cell_idx,data_cell) {
				var cur_meeting = sect_obj.meetings[meeting_idx],
						cell_contents = $(data_cell).text();

				if(cell_idx == 1) {
					var time_comps = cell_contents.split('-');
					if (time_comps.length == 2) {
						cur_meeting.start_time = time_comps[0].trim();
						cur_meeting.end_time = time_comps[1].trim();												
					}else {
						cur_meeting.start_time = time_comps[0].trim();
						cur_meeting.end_time = time_comps[0].trim();																							
					}
				}else if(cell_idx == 2) {
					cur_meeting.days = cell_contents.trim();
				}else if(cell_idx == 3) {
					cur_meeting.location = cell_contents.trim();											
				}else if(cell_idx == 4) {
					var date_comps = cell_contents.split('-');
					cur_meeting.start_date = date_comps[0].trim();
					cur_meeting.end_date = date_comps[1].trim();
				}else if(cell_idx == 5) {
					cur_meeting.type = cell_contents.trim();
				}else if(cell_idx == 6) {
					cur_meeting.instructor = cell_contents.trim();
				}

			});
		});
	};

	//Parse the shit above the meeting time tables
	function parse_upper_table(upper_table, sect_obj, cb) {
		var i = 0;
		while(i < upper_table.length) {
			var test = upper_table[i].trim();
			if(test.length > 0) {
				sect_obj.warnings = test;
				break;
			}
		}

		var reg_dates = upper_table.filter(function(e) {
			return e.match(/Registration Dates/i);
		});

		if(reg_dates.length) {
			var reg_dates = reg_dates[0].split(':').pop().trim(),
					reg_date_comps = reg_dates.split(' to ');
			sect_obj.reg_start_date = new Date(reg_date_comps[0]);
			sect_obj.reg_end_date = new Date(reg_date_comps[1]);
		}

		var levels = upper_table.filter(function(e) {
			return e.match(/Levels:/i);
		});

		if(levels.length) {
			var level_str = levels[0].split('>').pop().trim();
			sect_obj.levels = level_str.split(', ');
		}

		var grade_basis = upper_table.filter(function(e) {
			return e.match(/Grade Basis/i);
		});

		if(grade_basis.length) {
			sect_obj.grade_basis = grade_basis[0].split('>').pop().trim();
		}

		cb(sect_obj)
	};

	function eval_sect_title(title_comps, cb) {
		if(title_comps.length) {
			var check_obj = {
				term: term,
				crn: title_comps[1].trim()
			};

			_this.term_courses.find(check_obj)
			.on('success', function(docs) {
				if(!docs.length) { //The section isn't in the system, so add it
					var sect_obj = check_obj;

					sect_obj.title = title_comps[0].trim();

					var tmp = title_comps[2].trim().split(' ');
					sect_obj.subj = tmp[0];
					sect_obj.num = tmp[1];
					sect_obj.sect_id = title_comps[3].trim();

					cb(sect_obj);
				}
				cb(null);
			});
		};
	};


};

CourseConnector.prototype.save_course_info = function(first_argument) {
	// body...
};

CourseConnector.prototype.save_term_course = function(first_argument) {
	// body...
};

CourseConnector.prototype.link_to_text = function(link_e) {
	if(link_e && link_e.children && link_e.children.length > 0) {
		if(link_e.children[0] && link_e.children[0].data) {
			return link_e.children[0].data.trim();
		}
	}	

	return ""
};

CourseConnector.prototype.gt_https_req = function(path, cb) {
  var options = {
    hostname: 'oscar.gatech.edu',
    port: 443,
    path: path,
    method: 'GET',
    rejectUnauthorized: 'false'
  };

  var req = https.request(options, function(res) {
    var body = [];
    res.setEncoding('utf8');

    res
    .on('data', function(chunk) {
      body.push(chunk);
    })
    .on('end', function() {
    	var $ = cheerio.load(body.join(''));
    	cb($)
    });
  });

  req.end();
  req.on('error', function(e) {
     console.log("Error: " + e.message); 
     console.log( e.stack );
  });
};

module.exports = CourseConnector;
