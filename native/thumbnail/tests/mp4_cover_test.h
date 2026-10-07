#pragma once

#include <string>
#include <vector>

void RunMp4CoverTests(const std::wstring& redFixturePath);
std::vector<unsigned char> MakeSyntheticMp4CoverForTest(const std::vector<unsigned char>& image);
